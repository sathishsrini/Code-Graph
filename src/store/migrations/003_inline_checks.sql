-- ===========================================================================
-- 003_inline_checks  —  task P1-T10  (requirement R26)
-- ===========================================================================
-- `route_chain.detail` — the reviewed-helper-vs-shape discriminator.
--
-- The inline-auth channel produces two idioms of different inference
-- strength, both labelled `inferred`:
--
--   JS   sentinel-return binds a human-reviewed helper name (P1-T9's pack):
--        detail = `reviewed helper checkUserAuth`
--   py   header-compare-and-early-401 matches a source shape with no named
--        helper: detail = `header-compare-and-early-401 shape, no named helper`
--
-- The R40 coverage matrix (P1-T14) must not render them as equal coverage, so
-- the discriminator is stored per-row in this column, filled SOLELY by P1-T10
-- (R72: no column without a producer — every boot row keeps `detail` NULL and
-- stays honest).
-- ===========================================================================

ALTER TABLE route_chain ADD COLUMN detail TEXT;