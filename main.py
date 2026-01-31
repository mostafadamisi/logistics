#!/usr/bin/env python3
"""
Tactical Logistics Optimizer - Main Application
Single entry point that runs the FastAPI server with static file serving
"""
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field, conint
from typing import List, Dict, Any
import uvicorn
import webbrowser
import threading
import time
import os
from pathlib import Path

from app.config import TRUCK_CAPACITY_KG, API_PORT

# Initialize FastAPI application
app = FastAPI(
    title="Tactical Logistics Optimizer API",
    description="AI-powered route optimization for logistics operations",
    version="1.0.0"
)

# CORS middleware - allow all origins for development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static files (frontend)
current_dir = Path(__file__).resolve().parent
frontend_path = current_dir / "frontend"

print(f"DEBUG: Current Dir: {current_dir}")
print(f"DEBUG: Frontend Path: {frontend_path}")
print(f"DEBUG: Frontend Exists: {frontend_path.exists()}")

if frontend_path.exists():
    app.mount("/frontend", StaticFiles(directory=str(frontend_path), html=True), name="frontend")
else:
    print("WARNING: Frontend directory NOT found! Dashboard will not work.")


# ============================================================================
# DATA MODELS
# ============================================================================

class Order(BaseModel):
    """Single delivery order"""
    id: str = Field(..., description="Order ID")
    lat: float = Field(..., ge=-90, le=90, description="Latitude")
    lng: float = Field(..., ge=-180, le=180, description="Longitude")
    weight_kg: float = Field(..., gt=0, description="Weight in kilograms")


class OptimizeRequest(BaseModel):
    """Request payload for route optimization"""
    orders: List[Order]
    num_trucks: conint(gt=0) = 5


# ============================================================================
# API ENDPOINTS
# ============================================================================

@app.get("/")
async def root():
    """Redirect root to dashboard"""
    return RedirectResponse(url="/frontend/index.html")


@app.get("/health")
def health_check():
    """Health check endpoint"""
    print("💓 Health check received")
    return {"status": "healthy", "service": "Tactical Logistics Optimizer"}


@app.post("/optimize-routes")
async def optimize_routes(payload: OptimizeRequest) -> Dict[str, Any]:
    """
    Optimize delivery routes using AI-based clustering and TSP solving.
    
    Args:
        payload: Request containing orders and number of trucks
        
    Returns:
        Optimized routes with distances and sequences
        
    Raises:
        HTTPException: If validation fails or optimization errors occur
    """
    orders = payload.orders
    num_trucks = payload.num_trucks

    try:
        # Validate total weight against fleet capacity
        total_weight = sum(float(o.weight_kg) for o in orders)
        max_capacity = int(num_trucks) * TRUCK_CAPACITY_KG
        
        if total_weight > max_capacity:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Total weight {total_weight}kg exceeds fleet capacity "
                    f"({max_capacity}kg) for {num_trucks} trucks. Increase `num_trucks`."
                ),
            )

        # Convert orders to dicts for optimizer (support Pydantic v1 and v2)
        print(f"📦 Processing optimization request for {len(orders)} orders...")
        orders_dicts = [
            o.model_dump() if hasattr(o, 'model_dump') else o.dict() 
            for o in orders
        ]
        # Lazy import to keep cold-start fast for health checks
        from app.optimizer import optimize_routes_json
        result = optimize_routes_json(orders_dicts, num_trucks=int(num_trucks))

        # Validate optimizer output
        if not isinstance(result, dict) or "routes" not in result:
            raise HTTPException(
                status_code=500, 
                detail="Optimizer returned invalid result"
            )

        # Ensure all orders are in the solution
        input_ids = {o.id for o in orders}
        output_ids = {
            oid 
            for r in result.get("routes", []) 
            for oid in r.get("stop_sequence", [])
        }

        if input_ids != output_ids:
            missing = input_ids - output_ids
            # Check if missing orders are in 'unassigned_orders'
            unassigned = set(result.get("unassigned_orders", []))
            
            # Real missing are those neither in routes nor in unassigned list
            real_missing = missing - unassigned
            
            if real_missing or (output_ids - input_ids):
                extra = output_ids - input_ids
                raise HTTPException(
                    status_code=500,
                    detail={
                        "message": "Optimization incomplete: order mismatch",
                        "missing_order_ids": list(real_missing),
                        "extra_order_ids": list(extra),
                    },
                )

        # Validate capacity constraints
        for r in result.get("routes", []):
            if float(r.get("truck_load", 0)) > TRUCK_CAPACITY_KG:
                raise HTTPException(
                    status_code=500,
                    detail=f"Route {r.get('route_id')} exceeds capacity {TRUCK_CAPACITY_KG}kg",
                )

        # Validate order count
        if int(result.get("num_orders", 0)) != len(input_ids):
            raise HTTPException(
                status_code=500, 
                detail="Optimizer reported incorrect number of orders"
            )

        return result
        
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        import traceback
        traceback.print_exc() # Print full error to console
        raise HTTPException(
            status_code=500, 
            detail=f"Optimization failed: {str(e)}"
        )


# ============================================================================
# STARTUP LOGIC
# ============================================================================

def resolve_port() -> int:
    """Resolve the port from environment, falling back to config."""
    raw_port = os.getenv("PORT")
    if not raw_port:
        return API_PORT
    try:
        return int(raw_port)
    except ValueError:
        return API_PORT


def open_browser(port: int):
    """Open browser after a short delay"""
    time.sleep(2)
    webbrowser.open(f"http://127.0.0.1:{port}/frontend/index.html")


if __name__ == "__main__":
    port = resolve_port()
    print("\n" + "="*70)
    print("  Tactical Logistics Optimizer")
    print("="*70)
    print(f"\n🚀 Server starting...")
    if "PORT" in os.environ:
        print(f"🌍 Running in Cloud Mode (Port {port})")
    else:
        print(f"🏠 Running in Local Mode")
        print(f"📍 Dashboard: http://127.0.0.1:{port}/frontend/index.html")
        print(f"📚 API Docs: http://127.0.0.1:{port}/docs")
    print(f"\n⏹️  Press Ctrl+C to stop\n")
    
    # Only open browser if running locally (no PORT env var set)
    if "PORT" not in os.environ:
        threading.Thread(target=open_browser, args=(port,), daemon=True).start()
    
    # Start server
    uvicorn.run(
        app, 
        host="0.0.0.0", 
        port=port,
        log_level="info"
    )
