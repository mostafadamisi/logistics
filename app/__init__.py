"""
Tactical Logistics Optimizer - Application Package
"""

__version__ = "1.0.0"
__author__ = "Mustafa"

from .optimizer import optimize_routes_json, TRUCK_CAPACITY_KG

__all__ = ["optimize_routes_json", "TRUCK_CAPACITY_KG"]
