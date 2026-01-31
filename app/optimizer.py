"""
================================================================================
TACTICAL LOGISTICS DISPATCHER - ROUTE OPTIMIZATION ENGINE
================================================================================

PURPOSE:
    This module solves the Capacitated Vehicle Routing Problem (CVRP) using:
    1. AI-based clustering (K-Means) to group delivery locations
    2. Constraint programming (OR-Tools TSP) to optimize route sequences
    3. Capacity validation to ensure no truck is overloaded

BUSINESS CONTEXT:
    - Tactical planning focuses on resource allocation, not just directions
    - Minimizes total fleet mileage while respecting truck capacity constraints
    - Outputs structured JSON for integration with frontend/backend systems

AUTHOR: Mustafa (AI & Optimization Engine)
COMPANY: [Your Company Name]
VERSION: 1.0
================================================================================
"""

import numpy as np
import pandas as pd
from sklearn.cluster import KMeans
from ortools.constraint_solver import pywrapcp, routing_enums_pb2
from typing import List, Dict
import json

# Import configuration constants
from .config import DEPOT_LAT, DEPOT_LNG, TRUCK_CAPACITY_KG


# ============================================================================
# HELPER FUNCTION: BUILD DISTANCE MATRIX
# ============================================================================
def build_distance_matrix(coords: np.ndarray) -> np.ndarray:
    """
    Calculate the Euclidean distance matrix between all coordinate pairs.
    """
    # Calculate difference between all coordinate pairs using NumPy broadcasting
    # Shape: (N, 1, 2) - (1, N, 2) = (N, N, 2)
    diff = coords[:, np.newaxis, :] - coords[np.newaxis, :, :]
    
    # Calculate Euclidean distance: sqrt(dx^2 + dy^2)
    dist_matrix = np.sqrt(np.sum(diff**2, axis=2))
    
    # Convert to meters and cast to integer for OR-Tools
    return (dist_matrix * 1000).astype(int)


# ============================================================================
# CORE FUNCTION: SOLVE TSP FOR A SINGLE TRUCK CLUSTER
# ============================================================================
def solve_tsp_for_cluster(cluster_df: pd.DataFrame, depot: np.ndarray):
    """
    Solve the Traveling Salesperson Problem (TSP) for one truck's deliveries.
    """
    # EDGE CASE: If cluster is empty, return empty results
    if cluster_df.empty:
        return [], 0.0, []
    
    # STEP 1: Build coordinate array
    # Node 0 = depot (start/end point)
    # Nodes 1..N = delivery locations
    coords = np.vstack([depot, cluster_df[["lat","lng"]].values])
    
    # STEP 2: Build distance matrix
    dist_matrix = build_distance_matrix(coords)
    
    # STEP 3: Set up OR-Tools routing model
    N = len(coords)  # Total number of nodes (depot + deliveries)
    
    # RoutingIndexManager: Maps between node indices and routing solver indices
    manager = pywrapcp.RoutingIndexManager(N, 1, 0)
    
    # RoutingModel: The main TSP solver
    routing = pywrapcp.RoutingModel(manager)
    
    # STEP 4: Define distance callback
    def distance_callback(from_index, to_index):
        """Return distance between two nodes."""
        from_node = manager.IndexToNode(from_index)
        to_node = manager.IndexToNode(to_index)
        return dist_matrix[from_node, to_node]
    
    # Register the callback with the solver
    transit_callback_index = routing.RegisterTransitCallback(distance_callback)
    
    # Set the cost function (we want to minimize total distance)
    routing.SetArcCostEvaluatorOfAllVehicles(transit_callback_index)
    
    # STEP 5: Configure search parameters
    search_params = pywrapcp.DefaultRoutingSearchParameters()
    search_params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    search_params.time_limit.seconds = 2
    
    # STEP 6: Solve the TSP
    solution = routing.SolveWithParameters(search_params)
    
    # If no solution found, return empty results
    if not solution:
        return [], 0.0, []
    
    # STEP 7: Extract the solution
    index = routing.Start(0)
    route_nodes = []
    route_distance = 0
    
    while not routing.IsEnd(index):
        node = manager.IndexToNode(index)
        route_nodes.append(node)
        next_index = solution.Value(routing.NextVar(index))
        route_distance += routing.GetArcCostForVehicle(index, next_index, 0)
        index = next_index
    
    # STEP 8: Convert solution to business format
    stop_sequence = [cluster_df.iloc[node-1]["id"] for node in route_nodes[1:]]
    distance_km = round(route_distance / 1000, 3)
    
    # STEP 9: Get real street routes using OSRM
    try:
        from .routing_service import get_route_for_sequence
        
        sequence = [
            (float(cluster_df.iloc[node-1]["lat"]), float(cluster_df.iloc[node-1]["lng"]))
            for node in route_nodes[1:]
        ]
        
        route_info = get_route_for_sequence(sequence, depot)
        
        polyline = route_info["polyline"]
        delivery_polyline = route_info["delivery_polyline"]
        return_polyline = route_info["return_polyline"]
        distance_km = route_info["total_distance_km"]
        total_duration = route_info["total_duration_minutes"]
        
        STOP_DURATION_MINUTES = 5
        stop_etas = []
        cumulative_time = 0
        
        for i, segment in enumerate(route_info["segments"][:-1]):
            cumulative_time += segment["duration_minutes"]
            if i > 0:
                cumulative_time += STOP_DURATION_MINUTES
            stop_etas.append({
                "stop_id": stop_sequence[i] if i < len(stop_sequence) else None,
                "eta_minutes": round(cumulative_time, 1),
                "distance_from_depot_km": round(sum(s["distance_km"] for s in route_info["segments"][:i+1]), 2)
            })
        
    except Exception as e:
        import logging
        logging.warning(f"OSRM routing failed, using fallback: {e}")
        
        polyline = [depot.tolist()] + [
            [float(cluster_df.iloc[node-1]["lat"]), float(cluster_df.iloc[node-1]["lng"])]
            for node in route_nodes[1:]
        ] + [depot.tolist()]
        
        total_duration = (distance_km / 40) * 60
        delivery_polyline = polyline[:-1]
        return_polyline = [polyline[-2], polyline[-1]] if len(polyline) > 1 else []
        stop_etas = []
    
    return stop_sequence, distance_km, polyline, delivery_polyline, return_polyline, total_duration, stop_etas


def optimize_routes_json(orders: List[Dict], num_trucks: int = 5) -> Dict:
    """
    Main optimization function: Assigns orders to trucks and optimizes routes.
    """
    if not orders:
        raise ValueError("Orders list cannot be empty")
    
    df = pd.DataFrame(orders)
    required_cols = ["id", "lat", "lng", "weight_kg"]
    if any(col not in df.columns for col in required_cols):
        raise ValueError(f"Orders must contain columns: {required_cols}")
    
    X = df[["lat", "lng"]].values
    effective_clusters = min(num_trucks, len(X))
    kmeans = KMeans(n_clusters=effective_clusters, random_state=42, n_init=10)
    df["truck_cluster"] = kmeans.fit_predict(X) + 1
    
    unassigned_orders = []
    for i in range(3):
        for truck_id in sorted(df["truck_cluster"].unique()):
            cluster_df = df[df["truck_cluster"] == truck_id]
            total_weight = cluster_df["weight_kg"].sum()
            
            if total_weight > TRUCK_CAPACITY_KG:
                excess_df = cluster_df.sort_values(by="weight_kg", ascending=False)
                for idx, row in excess_df.iterrows():
                    if df[df["truck_cluster"] == truck_id]["weight_kg"].sum() <= TRUCK_CAPACITY_KG:
                        break
                    
                    moved = False
                    for other_id in sorted(df["truck_cluster"].unique()):
                        if other_id == truck_id: continue
                        other_weight = df[df["truck_cluster"] == other_id]["weight_kg"].sum()
                        if other_weight + row["weight_kg"] <= TRUCK_CAPACITY_KG:
                            df.loc[idx, "truck_cluster"] = other_id
                            moved = True
                            break
    
    for truck_id in sorted(df["truck_cluster"].unique()):
        total_weight = df[df["truck_cluster"] == truck_id]["weight_kg"].sum()
        while total_weight > TRUCK_CAPACITY_KG:
            heaviest_idx = df[df["truck_cluster"] == truck_id]["weight_kg"].idxmax()
            df.loc[heaviest_idx, "truck_cluster"] = 0
            total_weight = df[df["truck_cluster"] == truck_id]["weight_kg"].sum()

    depot = np.array([DEPOT_LAT, DEPOT_LNG])
    routes = []
    
    for truck_id in sorted(df["truck_cluster"].unique()):
        if truck_id == 0: continue
        cluster_df = df[df["truck_cluster"] == truck_id].reset_index(drop=True)
        stop_sequence, distance_km, polyline, delivery_polyline, return_polyline, duration_minutes, stop_etas = solve_tsp_for_cluster(cluster_df, depot)
        
        routes.append({
            "route_id": int(truck_id),
            "stop_sequence": stop_sequence,
            "truck_load": float(cluster_df["weight_kg"].sum()),
            "total_distance": distance_km,
            "total_duration": duration_minutes,
            "polyline": polyline,
            "delivery_polyline": delivery_polyline,
            "return_polyline": return_polyline,
            "stop_etas": stop_etas
        })
    
    unassigned_df = df[df["truck_cluster"] == 0]
    unassigned_ids = unassigned_df["id"].tolist()
    total_distance = round(sum(r["total_distance"] for r in routes), 3)
    
    output_json = {
        "num_trucks": len(routes),
        "truck_capacity_kg": TRUCK_CAPACITY_KG,
        "num_orders": len(df),
        "total_distance_km": total_distance,
        "routes": routes,
        "unassigned_orders": unassigned_ids
    }
    
    return output_json


if __name__ == "__main__":
    np.random.seed(42)
    num_orders = 50
    sample_orders = []
    for i in range(1, num_orders + 1):
        sample_orders.append({
            "id": f"ORD-{i:03d}",
            "lat": DEPOT_LAT + np.random.uniform(-0.08, 0.08),
            "lng": DEPOT_LNG + np.random.uniform(-0.10, 0.10),
            "weight_kg": int(np.random.randint(20, 300))
        })
    
    print("\n" + "="*80)
    print("RUNNING TACTICAL LOGISTICS OPTIMIZER")
    print("="*80)
    result_json = optimize_routes_json(sample_orders, num_trucks=5)
    print(json.dumps(result_json, indent=2))
