"""
OSRM Routing Service
Provides real street-based routing using OpenStreetMap data
"""
import requests
from typing import List, Tuple, Optional, Dict
import time
from functools import lru_cache
import logging

logger = logging.getLogger(__name__)

OSRM_BASE_URL = "http://router.project-osrm.org/route/v1/driving"
REQUEST_TIMEOUT = 10
MAX_RETRIES = 3
RETRY_DELAY = 1


class RoutingError(Exception):
    """Raised when routing fails"""
    pass


@lru_cache(maxsize=1000)
def get_route(
    start_lat: float,
    start_lng: float,
    end_lat: float,
    end_lng: float,
    use_cache: bool = True
) -> Dict:
    """Get route between two points using OSRM API."""
    url = f"{OSRM_BASE_URL}/{start_lng},{start_lat};{end_lng},{end_lat}"
    params = {
        "overview": "full",
        "geometries": "geojson"
    }
    
    for attempt in range(MAX_RETRIES):
        try:
            response = requests.get(url, params=params, timeout=REQUEST_TIMEOUT)
            response.raise_for_status()
            data = response.json()
            
            if data.get("code") != "Ok":
                raise RoutingError(f"OSRM error: {data.get('message', 'Unknown error')}")
            
            route = data["routes"][0]
            distance_m = route["distance"]
            duration_s = route["duration"]
            coordinates = route["geometry"]["coordinates"]
            polyline = [[coord[1], coord[0]] for coord in coordinates]
            
            return {
                "distance_km": round(distance_m / 1000, 3),
                "duration_minutes": round(duration_s / 60, 1),
                "polyline": polyline,
                "is_fallback": False
            }
            
        except (requests.RequestException, RoutingError) as e:
            logger.warning(f"OSRM request failed (attempt {attempt + 1}/{MAX_RETRIES}): {e}")
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_DELAY * (2 ** attempt))
            else:
                return _euclidean_fallback(start_lat, start_lng, end_lat, end_lng)
    
    return _euclidean_fallback(start_lat, start_lng, end_lat, end_lng)


def _euclidean_fallback(
    start_lat: float,
    start_lng: float,
    end_lat: float,
    end_lng: float
) -> Dict:
    """Fallback to Euclidean distance."""
    import math
    dlat = end_lat - start_lat
    dlng = end_lng - start_lng
    distance_deg = math.sqrt(dlat**2 + dlng**2)
    distance_km = distance_deg * 111
    duration_minutes = (distance_km / 40) * 60
    polyline = [[start_lat, start_lng], [end_lat, end_lng]]
    
    return {
        "distance_km": round(distance_km, 3),
        "duration_minutes": round(duration_minutes, 1),
        "polyline": polyline,
        "is_fallback": True
    }


def get_route_for_sequence(
    sequence: List[Tuple[float, float]],
    depot: Tuple[float, float]
) -> Dict:
    """Get complete route for a sequence of points."""
    waypoints = [depot] + sequence + [depot]
    segments = []
    total_distance = 0
    total_duration = 0
    complete_polyline = []
    has_fallback = False
    delivery_polyline = []
    return_polyline = []
    
    for i in range(len(waypoints) - 1):
        start = waypoints[i]
        end = waypoints[i + 1]
        route = get_route(start[0], start[1], end[0], end[1])
        segments.append(route)
        total_distance += route["distance_km"]
        total_duration += route["duration_minutes"]
        
        if route["is_fallback"]:
            has_fallback = True
        
        is_return_leg = (i == len(waypoints) - 2)
        segment_coords = route["polyline"]
        if is_return_leg:
            if not return_polyline:
                return_polyline.extend(segment_coords)
            else:
                return_polyline.extend(segment_coords[1:])
        else:
            if i == 0:
                delivery_polyline.extend(segment_coords)
            else:
                delivery_polyline.extend(segment_coords[1:])
                
        if i == 0:
            complete_polyline.extend(segment_coords)
        else:
            complete_polyline.extend(segment_coords[1:])
    
    return {
        "total_distance_km": round(total_distance, 3),
        "total_duration_minutes": round(total_duration, 1),
        "polyline": complete_polyline,
        "delivery_polyline": delivery_polyline,
        "return_polyline": return_polyline,
        "segments": segments,
        "has_fallback": has_fallback
    }


def clear_cache():
    """Clear the routing cache"""
    get_route.cache_clear()
