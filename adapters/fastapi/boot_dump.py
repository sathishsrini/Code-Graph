#!/usr/bin/env python3
"""FastAPI boot reflection  —  task P1-T4  (requirements R22, R23, R24, R25).

The boot channel for Python services. Same contract as
``adapters/fastify/boot-dump.cjs``: import the application, let the framework
finish building itself, then ask *it* what routes exist and what runs on them.
The output is the route + middleware ground truth and is tagged ``certain``.

Why reflection rather than parsing the decorators: the same reason it won the
argument on the Node side. A decorator tells you a route was declared. It does
not tell you the full path after ``include_router(prefix=...)``, it does not
tell you which middleware wraps it, and it does not tell you the order. Those
are properties of the assembled application.

Three things this adapter takes from what the Fastify one measured:

* **Located, not renamed** (delta D3). Every chain entry carries
  ``file:line:col``, obtained from ``inspect``. Names are recorded when they
  exist and are never relied on: a dependency can be a lambda, and a middleware
  can be a class instance.
* **Read after the app is built** (delta D5). Starlette assembles its
  middleware stack lazily; ``app.user_middleware`` is the declaration and
  ``build_middleware_stack()`` is what runs. Both are reported.
* **Say what was not found.** ``warnings`` is part of the artifact, not stderr.

Run:
    python adapters/fastapi/boot_dump.py --entry <path/to/main.py> \
        --cwd <repo root> --service <name> --out <artifact.json>
"""

from __future__ import annotations

import argparse
import importlib.util
import inspect
import json
import os
import sys
import traceback
from typing import Any

SCHEMA = "codeintel.boot.fastapi/1"

# R23: key names and whether a value is set. Never values, not even redacted
# and not even hashed — a hashed secret is a secret with an oracle attached.
# This list only decides which keys are worth reporting at all.
CONFIG_PREFIXES = (
    "DATABASE_", "DB_", "SERVICE_", "INTEGRATION_", "PORT", "HOST",
    "API_", "AUTH_", "JWT_", "SECRET", "TOKEN", "KEY", "URL", "BASE_",
)


def location(obj: Any) -> dict[str, Any]:
    """``file:line:col`` for any callable, or nulls with the reason.

    The join key into SCIP, exactly as on the Node side. A dependency declared
    as a lambda has no usable name and this is the only way to identify it.
    """
    target = inspect.unwrap(obj) if callable(obj) else obj
    # A class-based middleware: locate the class, not the instance.
    if inspect.isclass(target):
        pass
    elif not (inspect.isfunction(target) or inspect.ismethod(target)):
        target = type(target)

    try:
        file = inspect.getsourcefile(target)
        _, line = inspect.getsourcelines(target)
    except (TypeError, OSError) as exc:
        return {"file": None, "line": None, "col": None, "locationError": str(exc)}

    return {"file": file, "line": line, "col": 0, "locationError": None}


def relative(path: str | None, root: str) -> str | None:
    if not path:
        return None
    try:
        return os.path.relpath(path, root).replace("\\", "/")
    except ValueError:
        return path.replace("\\", "/")


def name_of(obj: Any) -> str | None:
    for attr in ("__qualname__", "__name__"):
        value = getattr(obj, attr, None)
        if isinstance(value, str) and value:
            return value
    cls = type(obj)
    return getattr(cls, "__name__", None)


def chain_entry(
    position: int, phase: str, obj: Any, root: str, origin: str,
    inherited_from: str | None = None, check_kind: str | None = None,
) -> dict[str, Any]:
    loc = location(obj)
    rel = relative(loc["file"], root)
    name = name_of(obj)
    anonymous = name in (None, "<lambda>", "")
    # Anything resolving outside the repo is the framework's, not the service's.
    # Starlette's own CORSMiddleware is real and runs, but it is not code this
    # service owns and no SCIP index of this repo will contain it.
    if rel is not None and (os.path.isabs(rel) or rel.startswith("..")):
        origin = "framework"
    key = (
        f"{rel}:{loc['line']}:{loc['col']}"
        if rel and loc["line"] is not None
        else f"<unlocated>:{name or '?'}"
    )
    return {
        "position": position,
        "phase": phase,
        "name": None if anonymous else name,
        "key": key,
        "file": rel,
        "line": loc["line"],
        "col": loc["col"],
        "anonymous": anonymous,
        "origin": origin,
        "declaredIn": getattr(obj, "__module__", None),
        "inheritedFrom": inherited_from,
        "checkKind": check_kind,
        "locationError": loc["locationError"],
    }


def flatten_dependencies(dependant: Any, root: str, depth: int = 0) -> list[dict[str, Any]]:
    """R22: recurse ``route.dependant.dependencies``, preserving order.

    FastAPI resolves sub-dependencies before the dependency that requires them,
    so a post-order walk is the execution order. Depth is recorded because
    ``Depends(get_current_user)`` nesting ``Depends(get_db)`` is a real
    ordering fact a reader needs, and a flat list loses it.
    """
    out: list[dict[str, Any]] = []
    if dependant is None:
        return out
    for sub in getattr(dependant, "dependencies", []) or []:
        out.extend(flatten_dependencies(sub, root, depth + 1))
        call = getattr(sub, "call", None)
        if call is None:
            continue
        entry = chain_entry(0, "dependency", call, root, "scope")
        entry["depth"] = depth
        entry["security"] = _is_security_dependency(sub)
        out.append(entry)
    return out


def _is_security_dependency(dependant: Any) -> bool:
    """True when FastAPI itself classified this dependency as a security scheme.

    This is the one auth signal the framework hands over for free, and it is
    `certain` in a way nothing static can be. It is also the signal this corpus
    does not produce: `51-integration` validates a bearer token with a plain
    header compare inside the handler, so every route here reports False and
    the inline detector (R26 / P1-T10) is what has to find it.
    """
    return bool(getattr(dependant, "security_requirements", None)) or bool(
        getattr(dependant, "security_scopes", None)
    )


def load_app(entry: str, cwd: str) -> tuple[Any, list[str]]:
    """Import the entry module and find the FastAPI instance in it."""
    warnings: list[str] = []
    sys.path.insert(0, cwd)
    os.chdir(cwd)

    spec = importlib.util.spec_from_file_location("__codeintel_boot__", entry)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {entry}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["__codeintel_boot__"] = module
    spec.loader.exec_module(module)

    from fastapi import FastAPI  # imported here so a missing dep is a clear error

    apps = [v for v in vars(module).values() if isinstance(v, FastAPI)]
    if not apps:
        raise RuntimeError(f"no FastAPI instance found in {entry}")
    if len(apps) > 1:
        # Reported, not silently resolved. Picking one would make the artifact
        # describe half the service with nothing saying so.
        warnings.append(
            f"{len(apps)} FastAPI instances in {entry}; using the first. "
            "Declare the entrypoint more precisely if this is wrong."
        )
    return apps[0], warnings


def middleware_chain(app: Any, root: str) -> list[dict[str, Any]]:
    """The app-wide middleware stack, outermost first.

    Starlette's ``add_middleware`` **inserts at index 0**, so list order is
    execution order (index 0 runs first) while being the reverse of source
    order. Reporting the list order is correct and reporting the source order
    would be wrong; the distinction is worth stating because it is invisible
    and silently inverts an answer to "what runs first".

    Unlike Fastify hooks these are not per-route: they wrap the router itself,
    so every route in the app carries the same prefix.
    """
    out: list[dict[str, Any]] = []
    for index, mw in enumerate(getattr(app, "user_middleware", []) or []):
        target = getattr(mw, "cls", mw)
        # BaseHTTPMiddleware wrapping a plain @app.middleware("http") function
        # hides the interesting callable in its kwargs.
        options = getattr(mw, "kwargs", None) or {}
        dispatch = options.get("dispatch")
        entry = chain_entry(index, "middleware", dispatch or target, root, "scope")
        entry["middlewareClass"] = name_of(target)
        out.append(entry)
    return out


def collect_routes(app: Any, service: str, root: str, middleware: list[dict]) -> tuple[list[dict], list[str]]:
    from fastapi.routing import APIRoute

    warnings: list[str] = []
    routes: list[dict[str, Any]] = []

    for route in app.routes:
        if not isinstance(route, APIRoute):
            # Starlette's own /openapi.json, /docs, /redoc and mounts. Counted
            # rather than dropped: "3 routes, 4 non-API routes skipped" is a
            # different statement from "3 routes".
            continue

        endpoint = route.endpoint
        deps = flatten_dependencies(route.dependant, root)
        for method in sorted(route.methods or []):
            chain: list[dict[str, Any]] = []
            position = 0
            for mw in middleware:
                item = dict(mw)
                item["position"] = position
                chain.append(item)
                position += 1
            for dep in deps:
                item = dict(dep)
                item["position"] = position
                chain.append(item)
                position += 1
            handler = chain_entry(position, "handler", endpoint, root, "route")
            chain.append(handler)

            routes.append({
                "method": method,
                "url": route.path,
                "prefix": "",
                "routeKey": f"{service} {method} {route.path}",
                "constraints": None,
                # OPEN-6: response_model is the only schema this corpus has,
                # and it is None everywhere — the handler takes a raw Request.
                "hasSchema": route.response_model is not None,
                "logLevel": None,
                "endpointModule": getattr(endpoint, "__module__", None),
                "endpointQualname": getattr(endpoint, "__qualname__", None),
                "chain": chain,
                "offPath": [],
            })

    if not routes:
        warnings.append("no APIRoute found — check the entrypoint names the module that builds the app")
    return routes, warnings


def openapi_of(app: Any) -> tuple[Any, list[str]]:
    warnings: list[str] = []
    try:
        spec = app.openapi()
    except Exception as exc:  # a broken schema must not take the dump with it
        return None, [f"app.openapi() raised {type(exc).__name__}: {exc}"]

    schemas = ((spec or {}).get("components") or {}).get("schemas") or {}
    if not schemas:
        # OPEN-6, stated in the artifact rather than discovered later as an
        # unexplained column of nulls.
        warnings.append(
            "app.openapi() produced no component schemas. Handlers taking a raw "
            "Request emit no requestBody, so routes.request_schema stays null."
        )
    return spec, warnings


def config_names() -> list[dict[str, Any]]:
    """R23: which config keys exist and whether each is set. Never values."""
    out = []
    for key in sorted(os.environ):
        if any(key.startswith(p) or p in key for p in CONFIG_PREFIXES):
            out.append({"name": key, "isSet": os.environ.get(key, "") != ""})
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--entry", required=True)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--service", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    root = os.path.abspath(args.cwd)
    out_path = os.path.abspath(args.out)

    try:
        app, warnings = load_app(os.path.abspath(args.entry), root)
    except Exception as exc:
        sys.stderr.write(f"boot dump failed: {exc}\n{traceback.format_exc()}")
        return 1

    import fastapi
    import starlette

    middleware = middleware_chain(app, root)
    routes, route_warnings = collect_routes(app, args.service, root, middleware)
    spec, schema_warnings = openapi_of(app)
    warnings.extend(route_warnings)
    warnings.extend(schema_warnings)

    non_api = sum(1 for r in app.routes if type(r).__name__ != "APIRoute")
    chain_entries = sum(len(r["chain"]) for r in routes)
    anonymous = sum(1 for r in routes for c in r["chain"] if c["anonymous"])
    unlocated = sum(1 for r in routes for c in r["chain"] if c["line"] is None)

    dump = {
        "schema": SCHEMA,
        "service": args.service,
        # Fixed, not `now`: the Phase 0 determinism criterion is that two runs
        # produce byte-identical output, and a timestamp defeats it for no gain.
        "generatedAt": "",
        "evidenceKind": "boot",
        "confidence": "certain",
        "tool": {
            "adapter": "adapters/fastapi/boot_dump.py",
            "fastapi": fastapi.__version__,
            "starlette": starlette.__version__,
            "python": sys.version.split()[0],
        },
        "entrypoint": relative(os.path.abspath(args.entry), root),
        "repoRoot": root,
        "stats": {
            "routes": len(routes),
            "nonApiRoutes": non_api,
            "chainEntries": chain_entries,
            "anonymousChainEntries": anonymous,
            "unlocatedChainEntries": unlocated,
            "middleware": len(middleware),
        },
        "routes": routes,
        "middleware": middleware,
        "openapi": spec,
        "config": config_names(),
        "warnings": warnings,
    }

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(dump, fh, indent=2, sort_keys=False)
        fh.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
