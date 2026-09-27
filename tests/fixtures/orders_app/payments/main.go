package main

import (
	"encoding/json"
	"net/http"
)

type chargeRequest struct {
	CustomerID int     `json:"customer_id"`
	Amount     float64 `json:"amount"`
}

func chargeHandler(w http.ResponseWriter, r *http.Request) {
	var req chargeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	approved := req.Amount < 1000
	json.NewEncoder(w).Encode(map[string]any{"approved": approved})
}

func main() {
	http.HandleFunc("/charge", chargeHandler)
	http.ListenAndServe(":8080", nil)
}
