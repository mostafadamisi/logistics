/**
 * Devorise Tactical Logistics - Frontend Controller
 * Refactored Version 2.0 (Modular Architecture)
 */

// ==========================================
// 1. CONFIGURATION & CONTRACTS
// ==========================================

const CONFIG = {
    DEPOT: [36.1627, -86.7816], // Nashville, TN
    API_URL: '/optimize-routes',
    COLORS: [
        '#00F0FF', // Cyan (Electric)
        '#FF5500', // Orange (Safety)
        // Use 6-digit hex to avoid libs interpreting 8-digit hex as ARGB (causing color mismatches)
        '#00FF1A', // Green
        '#0099CC', // Dim Cyan
        '#FF3333', // Alert Red
    ],
    MAP_TILES: 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png?api_key=3ebe892c-01a9-477a-8733-f7229b9ef29d',
    MAP_ATTRIBUTION: 'Devorise Tactical Logistics',
    TOAST_DURATION: 4000
};

function getRouteColor(route, index) {
    const routeId = Number(route?.route_id);
    if (Number.isFinite(routeId) && routeId > 0) {
        return CONFIG.COLORS[(routeId - 1) % CONFIG.COLORS.length];
    }
    return CONFIG.COLORS[index % CONFIG.COLORS.length];
}

// ==========================================
// 2. STATE STORE
// ==========================================

class Store {
    constructor() {
        this.points = this.loadPoints();
        this.optResult = this.loadOptResult();
        this.isEditMode = false;
        this.pendingCoords = null;
    }

    loadPoints() {
        try {
            const saved = localStorage.getItem('delivery_points');
            return saved ? JSON.parse(saved) : [];
        } catch (e) { return []; }
    }

    savePoints() {
        localStorage.setItem('delivery_points', JSON.stringify(this.points));
    }

    loadOptResult() {
        try {
            return JSON.parse(localStorage.getItem('opt_result') || 'null');
        } catch (e) { return null; }
    }

    saveOptResult(result) {
        this.optResult = result;
        localStorage.setItem('opt_result', JSON.stringify(result));
    }

    clearOptResult() {
        this.optResult = null;
        localStorage.removeItem('opt_result');
    }

    addPoint(point) {
        this.points.push(point);
        this.savePoints();
    }

    removePoint(index) {
        this.points.splice(index, 1);
        this.savePoints();
    }

    updatePointWeight(index, weight) {
        if (this.points[index]) {
            this.points[index].weight_kg = Number(weight);
            this.savePoints();
        }
    }

    clearPoints() {
        this.points = [];
        this.savePoints();
    }
}

// ==========================================
// 3. API SERVICE
// ==========================================

class APIService {
    static async optimizeRoutes(orders, numTrucks) {
        // Use full URL for local safety if needed, here just relative
        const res = await axios.post(CONFIG.API_URL, { orders, num_trucks: numTrucks }, {
            timeout: 120000 // 2 minutes
        });
        return res.data;
    }

    static async geocode(address) {
        // Check for coordinates first "lat, lng"
        const coordMatch = address.match(/^(-?\d+\.\d*)\s*,\s*(-?\d+\.\d*)$/);
        if (coordMatch) {
            return { lat: parseFloat(coordMatch[1]), lng: parseFloat(coordMatch[2]) };
        }

        // Use Nominatim
        const res = await axios.get(`https://nominatim.openstreetmap.org/search`, {
            params: { q: address, format: 'json', limit: 1 }
        });

        if (res.data && res.data.length > 0) {
            return { lat: parseFloat(res.data[0].lat), lng: parseFloat(res.data[0].lon) };
        }
        throw new Error("Location not found");
    }

    static async checkHealth() {
        const baseUrl = window.location.origin === 'null' ? 'http://localhost:8080' : '';
        return await axios.get(`${baseUrl}/health`);
    }
}

// ==========================================
// 4. MAP SERVICE
// ==========================================

class MapService {
    constructor(mapId) {
        if (typeof L === 'undefined') throw new Error("Leaflet is required");

        this.map = L.map(mapId).setView(CONFIG.DEPOT, 12);
        this.markers = {};
        this.routeLayers = [];

        L.tileLayer(CONFIG.MAP_TILES, {
            maxZoom: 19,
            attribution: CONFIG.MAP_ATTRIBUTION
        }).addTo(this.map);

        this.initDepot();
    }

    initDepot() {
        const depotIcon = L.divIcon({
            className: 'custom-depot-icon',
            html: `
                <div style="
                    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
                    width: 40px; height: 40px;
                    display: flex; align-items: center; justify-content: center;
                    background: var(--devorise-navy);
                    border: 2px solid #00F0FF;
                    border-radius: 50%;
                    box-shadow: 0 0 10px rgba(0,0,0,0.5);
                    z-index: 2;
                ">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#00F0FF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M22 8.35V20a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8.35A2 2 0 0 1 3.26 6.5l8-3.2a2 2 0 0 1 1.48 0l8 3.2A2 2 0 0 1 22 8.35Z"></path>
                        <path d="M6 18h12"></path>
                        <path d="M6 14h12"></path>
                        <rect x="10" y="6" width="4" height="6"></rect>
                    </svg>
                </div>
            `,
            iconSize: [60, 60],
            iconAnchor: [30, 30],
            popupAnchor: [0, -30]
        });

        const m = L.marker(CONFIG.DEPOT, { icon: depotIcon, zIndexOffset: 1000 })
            .addTo(this.map)
            .bindPopup('Central Execution Depot', { closeButton: true });

        m.on('click', () => m.openPopup());
    }

    setCursor(type) {
        document.getElementById('map').style.cursor = type;
    }

    updateMarkers(points) {
        // Clear existing markers that are not in the new points list
        const currentIds = points.map(p => p.id);
        Object.keys(this.markers).forEach(id => {
            if (!currentIds.includes(id)) {
                this.map.removeLayer(this.markers[id]);
                delete this.markers[id];
            }
        });

        // Add/Update markers
        points.forEach((pt, i) => {
            const color = CONFIG.COLORS[i % CONFIG.COLORS.length];
            if (!this.markers[pt.id]) {
                const markerIcon = L.divIcon({
                    className: 'custom-div-icon',
                    html: `<div class="marker-diamond" style="--marker-color: ${color};"></div>`,
                    iconSize: [12, 12],
                    iconAnchor: [6, 6]
                });

                const marker = L.marker([pt.lat, pt.lng], { icon: markerIcon })
                    .addTo(this.map)
                    .bindPopup(`<b>${pt.id}</b> (${pt.weight_kg}kg)`);
                this.markers[pt.id] = marker;
            } else {
                // Update opacity if reused (can't easily update divicon style without re-init, but simple opacity works)
                this.markers[pt.id].setOpacity(1);
            }
        });
    }

    dimMarkers() {
        Object.values(this.markers).forEach(m => m.setOpacity(0.2));
    }

    clearRoutes() {
        this.routeLayers.forEach(l => this.map.removeLayer(l));
        this.routeLayers = [];
    }

    adjustOpacity(color, opacity) {
        if (color.startsWith('#')) {
            let c = color.substring(1).split('');
            if (c.length === 3) c = [c[0], c[0], c[1], c[1], c[2], c[2]];
            const r = parseInt(c.slice(0, 2).join(''), 16);
            const g = parseInt(c.slice(2, 4).join(''), 16);
            const b = parseInt(c.slice(4, 6).join(''), 16);
            return `rgba(${r},${g},${b},${opacity})`;
        }
        return color;
    }

    drawRoutes(routes, points) {
        this.clearRoutes();
        this.dimMarkers();

        routes.forEach((r, i) => {
            const color = getRouteColor(r, i);
            const dimmedColor = this.adjustOpacity(color, 0.25); // Dimmed background

            // 1. Delivery Path (AntPath)
            let deliveryRoute;
            if (L.polyline.antPath) {
                deliveryRoute = L.polyline.antPath(r.delivery_polyline, {
                    delay: 1000,
                    dashArray: [10, 40], // Longer gap for "ant" effect
                    weight: 5,
                    color: dimmedColor,     // Context path is dimmed
                    pulseColor: color,      // Ants are the TRUCK color
                    opacity: 1,
                    paused: false,
                    reverse: false,
                    hardwareAccelerated: true
                }).addTo(this.map);
            } else {
                deliveryRoute = L.polyline(r.delivery_polyline, { color: color, weight: 5 }).addTo(this.map);
            }

            // 2. Return Trip
            const returnTrip = L.polyline(r.return_polyline || [], {
                color: color, weight: 2, opacity: 0.2, dashArray: '5, 10'
            }).addTo(this.map);

            // 3. Arrows (Optional - might conflict visually with ants, keeping subtle)
            if (typeof L.polylineDecorator === 'function' && L.Symbol && L.Symbol.arrowHead) {
                try {
                    L.polylineDecorator(deliveryRoute, {
                        patterns: [{
                            offset: '10%', repeat: '20%',
                            symbol: L.Symbol.arrowHead({ pixelSize: 8, polygon: false, pathOptions: { stroke: true, color: color, weight: 1, opacity: 0.5 } })
                        }]
                    }).addTo(this.map);
                } catch (e) { }
            }

            // 4. Numbered Stop Markers
            r.stop_sequence.forEach((stopId, idx) => {
                const point = points.find(p => p.id === stopId);
                if (point) {
                    const stopIcon = L.divIcon({
                        className: 'custom-div-icon',
                        html: `
                            <div style="background:${color}; color:#fff; width:28px; height:28px; border-radius:50%; 
                            display:flex; align-items:center; justify-content:center; font-weight:800; font-size:14px; 
                            border:2px solid rgba(255,255,255,0.8); box-shadow:0 4px 8px rgba(0,0,0,0.4);">
                            ${idx + 1}
                            </div>`,
                        iconSize: [28, 28],
                        iconAnchor: [14, 14]
                    });
                    this.routeLayers.push(L.marker([point.lat, point.lng], { icon: stopIcon, zIndexOffset: 1000 }).addTo(this.map));
                }
            });

            // 5. Tooltip (Tactical)
            const durationText = r.total_duration ? `${Math.round(r.total_duration)} min` : 'N/A';
            const loadText = `${r.truck_load} kg`;

            // HTML Content for the tooltip
            const labelContent = `
                <div style="border-left: 3px solid ${color}; padding: 8px 12px;">
                    <div style="font-family: 'Space Grotesk'; font-weight: 700; text-transform: uppercase;">TRUCK ${r.route_id}</div>
                    <div style="display: flex; gap: 12px; margin-top: 4px; opacity: 0.8;">
                        <span><i data-lucide="clock" style="width:10px;display:inline"></i> ${durationText}</span>
                        <span><i data-lucide="weight" style="width:10px;display:inline"></i> ${loadText}</span>
                    </div>
                </div>
            `;

            deliveryRoute.bindTooltip(labelContent, {
                permanent: true,
                direction: 'top',
                offset: [0, -15],
                className: 'tactical-tooltip',
                opacity: 0.95
            }).openTooltip();

            this.routeLayers.push(deliveryRoute);
            this.routeLayers.push(returnTrip);
        });

        if (this.routeLayers.length > 0) {
            this.map.fitBounds(L.featureGroup(this.routeLayers).getBounds(), { padding: [50, 50] });
        }
    }

    zoomTo(lat, lng) {
        this.map.setView([lat, lng], 15);
    }
}

// ==========================================
// 5. UI SERVICE
// ==========================================

class UIService {
    constructor() {
        this.charts = {};
        this.loaderInterval = null;
        this.loaderHideTimeout = null;
        this.loaderTransitionHandler = null;
        this.initEventListeners();
    }

    initEventListeners() {
        // Navigation
        const navs = ['dashboard', 'stops', 'analytics'];
        navs.forEach(view => {
            const el = document.getElementById(`nav-${view}`);
            if (el) el.onclick = () => app.switchView(view);
        });

        // Buttons
        this.bindClick('toggleEdit', () => app.toggleEditMode());
        this.bindClick('genBtn', () => app.generatePlan());
        this.bindClick('randomBtn', () => app.addRandomPoints());
        this.bindClick('openManager', () => app.switchView('stops'));
        this.bindClick('clearRoutes', () => app.clearRoutes());
        this.bindClick('removeAllStops', () => app.resetAll());
        this.bindClick('add-stop-view-btn', () => app.addStopFromForm());
        this.bindClick('search-address-btn', () => app.searchAddress());

        // Modals
        this.bindClick('modalCancel', () => this.hideModal('addStopModal'));
        this.bindClick('modalAdd', () => app.confirmAddStopModal());

        this.bindClick('confirmCancel', () => this.hideModal('confirmModal'));
        this.bindClick('confirmYes', () => app.executeConfirmAction());
    }

    bindClick(id, handler) {
        const el = document.getElementById(id);
        if (el) el.onclick = handler;
    }

    switchView(viewId) {
        document.querySelectorAll('.view-container').forEach(v => v.style.display = 'none');
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

        const targetNav = document.getElementById(`nav-${viewId}`);
        const targetView = document.getElementById(`${viewId}-view`);

        if (targetView) targetView.style.display = 'block';
        // Note: Using 'active' class on nav items, not .style.display
        if (targetNav) targetNav.classList.add('active');
    }

    updateOverallStats(pointsCount, optResult, numTrucksInput) {
        // Dashboard Sidebars
        const count = pointsCount || 0;
        this.setText('pt-count', count);
        this.setText('ov-stops', count);

        if (optResult?.total_distance_km) {
            this.setText('ov-distance', `${optResult.total_distance_km.toFixed(2)} km`);
            this.setText('ov-trucks', optResult.routes.length);
            this.setText('total-dist', `${optResult.total_distance_km.toFixed(2)} km`);

            const totalLoad = optResult.routes.reduce((s, r) => s + (r.truck_load || 0), 0);
            const totalCap = optResult.truck_capacity_kg * (optResult.num_trucks || Number(numTrucksInput));
            const pct = totalCap > 0 ? ((totalLoad / totalCap) * 100).toFixed(1) : 0;
            this.setText('overall-pct', `${pct}% (${totalLoad}/${totalCap}kg)`);

            // Capacity Warning
            const warning = document.getElementById('capacityWarning');
            if (optResult.unassigned_orders?.length > 0) {
                warning.classList.remove('hidden');
                warning.innerHTML = `⚠️ <strong>Capacity Limit!</strong><br>${optResult.unassigned_orders.length} orders unassigned.`;
            } else {
                warning.classList.add('hidden');
            }
        } else {
            this.setText('ov-distance', '-');
            this.setText('ov-trucks', '-');
            this.setText('total-dist', '-');
            this.setText('overall-pct', '-');
            document.getElementById('capacityWarning').classList.add('hidden');
        }
    }

    renderStopsTable(points) {
        const tbody = document.getElementById('stops-table-body');
        const emptyMsg = document.getElementById('no-stops-msg');
        const badge = document.getElementById('stops-count-badge');

        tbody.innerHTML = '';
        badge.textContent = points.length;

        if (points.length === 0) {
            emptyMsg.style.display = 'block';
            return;
        }
        emptyMsg.style.display = 'none';

        points.forEach((pt, idx) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="font-weight: 600; color: var(--devorise-cyan);">${pt.id}</td>
                <td class="text-secondary">${pt.lat.toFixed(4)}, ${pt.lng.toFixed(4)}</td>
                <td>
                    <input type="number" class="devorise-input" value="${pt.weight_kg}" 
                        style="width: 80px; padding: 4px 8px;"
                        onchange="app.updateWeight(${idx}, this.value)">
                </td>
                <td>
                    <div class="action-btn-group">
                        <button class="action-icon-btn" onclick="app.zoomToStop(${pt.lat}, ${pt.lng})" aria-label="Zoom to location">
                            <i data-lucide="crosshair" style="width: 14px; height: 14px;"></i>
                        </button>
                        <button class="action-icon-btn delete" onclick="app.removeStop(${idx})" aria-label="Delete stop">
                            <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i>
                        </button>
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });
        lucide.createIcons();
    }

    renderTimeline(optResult, activeIdx = 0) {
        const timelineBox = document.getElementById('routeTimeline');
        const timelineList = document.getElementById('timelineItems');
        const tabs = document.getElementById('routeTabs');
        const header = document.getElementById('routeHeader');

        if (!optResult || !optResult.routes) {
            timelineBox.style.display = 'none';
            tabs.innerHTML = '';
            header.textContent = 'Initialize an agent';
            return;
        }

        timelineBox.style.display = 'block';
        tabs.innerHTML = '';
        timelineList.innerHTML = '';

        // Tabs
        optResult.routes.forEach((r, idx) => {
            const btn = document.createElement('button');
            const color = getRouteColor(r, idx);
            btn.className = `tab-btn ${idx === activeIdx ? 'active' : ''}`;
            btn.innerText = `T-${r.route_id}`;

            // Dynamic styling
            btn.style.setProperty('--btn-color', color);

            btn.onclick = () => this.renderTimeline(optResult, idx);
            tabs.appendChild(btn);
        });

        // Content
        const r = optResult.routes[activeIdx];
        const color = getRouteColor(r, activeIdx);

        // Apply color to the entire timeline container for the thread
        timelineList.style.setProperty('--timeline-color', color);
        header.style.setProperty('--route-color', color);

        header.innerHTML = `
            <div class="flex-between">
                <span>Stops: <strong>${r.stop_sequence.length}</strong></span>
                <span>Load: <strong>${r.truck_load} kg</strong></span>
            </div>
            <div class="mt-1">Distance: <strong>${r.total_distance.toFixed(1)} km</strong></div>
        `;

        // Timeline Items
        // Start (Depot)
        this.addTimelineItem(timelineList, 'Depot (Start)', 'Nashville Depot', '0 min', '0 kg', null, 'warehouse', 'Start');

        // Stops
        r.stop_sequence.forEach((stopId, i) => {
            const eta = r.stop_etas[i] ? `${Math.round(r.stop_etas[i].eta_minutes)} min` : '-';
            const pt = app.store.points.find(p => p.id === stopId);
            const load = pt ? `${pt.weight_kg} kg` : '-';
            this.addTimelineItem(timelineList, `Location ${stopId}`, 'Delivery Point', eta, load, i + 1, 'package', 'Stop');
        });

        // End (Depot)
        const totalTime = r.total_duration ? `${Math.round(r.total_duration)} min` : '?';
        this.addTimelineItem(timelineList, 'Depot (Return)', 'Base', totalTime, '-', null, 'flag', 'End');

        lucide.createIcons();
    }

    addTimelineItem(container, title, subtitle, time, load, badgeNum, iconName, status) {
        const item = document.createElement('div');
        item.className = 'timeline-item';
        const badge = badgeNum ? `<span style="background:var(--devorise-navy); color:var(--slate-200); padding:2px 6px; border-radius:4px; font-size:10px; border:1px solid rgba(255,255,255,0.1)">#${badgeNum}</span>` : '';

        item.innerHTML = `
            <div class="timeline-icon-box">
                <i data-lucide="${iconName}" style="width:16px; height:16px;"></i>
            </div>
            <div class="timeline-content">
                <div class="timeline-header">
                    <div class="timeline-title">
                        ${title} ${badge}
                    </div>
                </div>
                <div class="text-xs text-secondary mb-2">${subtitle}</div>
                <div class="timeline-badges">
                    <div class="t-badge highlight">
                        <i data-lucide="clock" style="width:10px"></i> ${time}
                    </div>
                    <div class="t-badge">
                        <i data-lucide="weight" style="width:10px"></i> ${load}
                    </div>
                </div>
            </div>
        `;
        container.appendChild(item);
    }

    updateAnalytics(optResult) {
        if (!optResult || !optResult.routes) return;

        // Helper to create gradients
        const createGradient = (ctx, color, isHorizontal = false) => {
            const gradient = isHorizontal
                ? ctx.createLinearGradient(0, 0, 300, 0) // Left to Right
                : ctx.createLinearGradient(0, 0, 0, 300); // Top to Bottom

            // Modern "Glow" effect
            gradient.addColorStop(0, color); // Solid at start
            gradient.addColorStop(1, this.adjustOpacity(color, 0.2)); // Fade out
            return gradient;
        };

        // Helper to parse hex/rgb and add opacity
        this.adjustOpacity = (color, opacity) => {
            // Simple hex to rgba converter for robustness
            if (color.startsWith('#')) {
                let c = color.substring(1).split('');
                if (c.length === 3) c = [c[0], c[0], c[1], c[1], c[2], c[2]];
                const r = parseInt(c.slice(0, 2).join(''), 16);
                const g = parseInt(c.slice(2, 4).join(''), 16);
                const b = parseInt(c.slice(4, 6).join(''), 16);
                return `rgba(${r},${g},${b},${opacity})`;
            }
            return color; // Fallback
        };

        // KPI Calculations
        const totalDist = Number(optResult.total_distance_km || 0);
        const totalLoad = optResult.routes.reduce((s, r) => s + (Number(r.truck_load) || 0), 0);
        const totalCap = (Number(optResult.truck_capacity_kg) || 1000) * (optResult.num_trucks || optResult.routes.length);
        const util = totalCap > 0 ? (totalLoad / totalCap) * 100 : 0;

        // Payload calc
        const payloads = optResult.routes.flatMap(r => r.stop_sequence.map(sid => {
            const p = app.store.points.find(pt => pt.id === sid);
            return p ? Number(p.weight_kg) : 0;
        }));
        const avgPayload = payloads.length ? payloads.reduce((a, b) => a + b, 0) / payloads.length : 0;

        this.setText('kpi-distance', `${totalDist.toFixed(2)} km`);
        this.setText('kpi-utilization', `${util.toFixed(1)}%`);
        this.setText('kpi-payload', `${avgPayload.toFixed(1)} kg`);
        if (optResult.frontend_total_time_ms) {
            this.setText('kpi-time', `${(optResult.frontend_total_time_ms / 1000).toFixed(2)}s`);
        } else if (optResult.calculation_time_ms) {
            // Fallback for older results
            this.setText('kpi-time', `${(optResult.calculation_time_ms / 1000).toFixed(2)}s`);
        }

        // --- Utilization Chart (Vertical Gradients) ---
        const utilCtx = document.getElementById('utilizationChart').getContext('2d');
        const utilGradients = optResult.routes.map((r, i) =>
            createGradient(utilCtx, getRouteColor(r, i), false)
        );

        this.updateChart('utilizationChart', 'bar', {
            labels: optResult.routes.map(r => `Truck ${r.route_id}`),
            datasets: [{
                label: 'Utl %',
                data: optResult.routes.map(r => ((r.truck_load / optResult.truck_capacity_kg) * 100).toFixed(1)),
                backgroundColor: utilGradients,
                borderRadius: 8,
                borderWidth: 0,
                barThickness: 40
            }]
        }, {
            scales: { y: { max: 100 } },
            animation: {
                duration: 2000,
                easing: 'easeOutQuart',
                delay: (context) => context.dataIndex * 200 // Staggered animation
            }
        });

        // --- Distance Chart (Horizontal Gradients) ---
        const distCtx = document.getElementById('distanceChart').getContext('2d');
        const distGradients = optResult.routes.map((r, i) =>
            createGradient(distCtx, getRouteColor(r, i), true)
        );

        this.updateChart('distanceChart', 'bar', {
            labels: optResult.routes.map(r => `Truck ${r.route_id}`),
            datasets: [{
                label: 'Km',
                data: optResult.routes.map(r => r.total_distance.toFixed(2)),
                backgroundColor: distGradients,
                borderRadius: 8,
                borderWidth: 0,
                barThickness: 25,
                indexAxis: 'y'
            }]
        }, {
            indexAxis: 'y',
            animation: {
                duration: 2000,
                easing: 'easeOutQuart',
                delay: (context) => context.dataIndex * 200
            }
        });

        // --- Payload Distribution (Doughnut) ---
        const bins = [0, 0, 0, 0];
        payloads.forEach(w => {
            if (w <= 50) bins[0]++; else if (w <= 120) bins[1]++; else if (w <= 250) bins[2]++; else bins[3]++;
        });
        const hasData = bins.some(b => b > 0);

        this.updateChart('payloadChart', 'doughnut', {
            labels: ['0-50 kg', '51-120 kg', '121-250 kg', '250+ kg'],
            datasets: [{
                data: hasData ? bins : [1],
                backgroundColor: hasData ? CONFIG.COLORS : ['#222'],
                borderColor: '#0a0f1a', // Match background for separation
                borderWidth: 4,
                hoverOffset: 16
            }]
        }, {
            cutout: '65%',
            animation: {
                animateScale: true,
                animateRotate: true,
                duration: 2000,
                easing: 'easeOutBounce'
            }
        });
    }

    updateChart(id, type, data, options) {
        if (this.charts[id]) this.charts[id].destroy();
        const ctx = document.getElementById(id).getContext('2d');

        // Modern Config Mixin
        const commonOptions = {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: type === 'doughnut',
                    position: 'bottom',
                    labels: {
                        color: '#93a3b8',
                        font: { family: "'IBM Plex Mono', monospace", size: 11 },
                        usePointStyle: true,
                        padding: 20
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(10, 15, 26, 0.9)',
                    titleColor: '#fff',
                    bodyColor: '#d7dde7',
                    borderColor: 'rgba(255,255,255,0.1)',
                    borderWidth: 1,
                    padding: 12,
                    cornerRadius: 8,
                    displayColors: true,
                    titleFont: { family: "'Space Grotesk', sans-serif" },
                    bodyFont: { family: "'Manrope', sans-serif" }
                }
            },
            scales: type !== 'doughnut' ? {
                y: {
                    beginAtZero: true,
                    grid: { color: 'rgba(255,255,255,0.05)', drawBorder: false },
                    ticks: { color: 'rgba(255,255,255,0.5)', font: { family: "'IBM Plex Mono', monospace", size: 10 } },
                    border: { display: false }
                },
                x: {
                    grid: { display: false, drawBorder: false },
                    ticks: { color: 'rgba(255,255,255,0.5)', font: { family: "'IBM Plex Mono', monospace", size: 10 } },
                    border: { display: false }
                }
            } : {},
            ...options
        };

        this.charts[id] = new Chart(ctx, { type, data, options: commonOptions });
    }

    showLoader(msg) {
        const ol = document.getElementById('loadingOverlay');
        const txt = document.getElementById('loadingStepText');

        if (!ol) return;

        // Cancel any pending hide (fade-out -> display:none)
        if (this.loaderHideTimeout) {
            clearTimeout(this.loaderHideTimeout);
            this.loaderHideTimeout = null;
        }
        if (this.loaderTransitionHandler) {
            ol.removeEventListener('transitionend', this.loaderTransitionHandler);
            this.loaderTransitionHandler = null;
        }

        ol.style.display = 'flex';
        // Next frame so opacity transition can run
        requestAnimationFrame(() => ol.classList.add('is-open'));

        // Reset text
        if (txt) txt.textContent = msg || 'INITIALIZING SYSTEM';

        // Clear any existing interval
        if (this.loaderInterval) clearInterval(this.loaderInterval);

        // Tactical Text Cycling
        const messages = [
            'AGENT FINDING BEST ROUTES',
            'CONTACTING LOGISTICS GRID',
            'SEARCHING FOR NEAREST STOP',
            'CALCULATING OPTIMAL PATHS',
            'ANALYZING TRAFFIC PATTERNS',
            'AGENT CALLING APIS',
            'SYNCING WITH FLEET COMMAND'
        ];

        let msgIdx = 0;
        this.loaderInterval = setInterval(() => {
            if (txt) {
                // Glitch effect or simple cycle
                txt.textContent = messages[msgIdx];
                msgIdx = (msgIdx + 1) % messages.length;
            }
        }, 1200); // 1.2s cycle
    }

    hideLoader() {
        const ol = document.getElementById('loadingOverlay');
        if (!ol) return;

        // Fade out then fully disable
        ol.classList.remove('is-open');

        const finish = () => {
            ol.style.display = 'none';
            if (this.loaderTransitionHandler) {
                ol.removeEventListener('transitionend', this.loaderTransitionHandler);
                this.loaderTransitionHandler = null;
            }
        };

        this.loaderTransitionHandler = finish;
        ol.addEventListener('transitionend', finish, { once: true });
        this.loaderHideTimeout = setTimeout(finish, 300);

        if (this.loaderInterval) {
            clearInterval(this.loaderInterval);
            this.loaderInterval = null;
        }
    }

    showToast(msg) {
        const c = document.getElementById('toastContainer');
        const t = document.createElement('div');
        t.className = 'toast';
        t.innerHTML = msg;
        c.appendChild(t);
        setTimeout(() => {
            t.style.opacity = '0';
            setTimeout(() => t.remove(), 300);
        }, CONFIG.TOAST_DURATION);
    }

    showModal(id) {
        document.getElementById(id).style.display = 'flex';
    }

    hideModal(id) {
        document.getElementById(id).style.display = 'none';
    }

    setText(id, val) {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    }
}

// ==========================================
// 6. MAIN APP CONTROLLER
// ==========================================

class App {
    constructor() {
        this.store = new Store();
        this.ui = new UIService();
        this.mapService = null; // initialized on load
        this.pendingAction = null;
    }

    init() {
        try {
            this.mapService = new MapService('map');
            this.mapService.map.on('click', (e) => this.handleMapClick(e));

            // Restore State
            this.mapService.updateMarkers(this.store.points);
            this.ui.renderStopsTable(this.store.points);

            if (this.store.optResult) {
                this.mapService.drawRoutes(this.store.optResult.routes, this.store.points);
                this.ui.renderTimeline(this.store.optResult);
                this.ui.updateOverallStats(this.store.points.length, this.store.optResult, this.getNumTrucks());
            } else {
                this.ui.updateOverallStats(this.store.points.length, null, this.getNumTrucks());
            }

            this.switchView('dashboard');
            this.startHealthCheck();
        } catch (e) {
            console.error("Init failed:", e);
            this.ui.showToast("Critical Error: Failed to initialize application.");
        }
    }

    switchView(viewId) {
        this.ui.switchView(viewId);
        if (viewId === 'dashboard' && this.mapService) {
            setTimeout(() => this.mapService.map.invalidateSize(), 50);
        }
        if (viewId === 'analytics') {
            this.ui.updateAnalytics(this.store.optResult);
        }
        if (viewId === 'stops') {
            this.ui.renderStopsTable(this.store.points);
        }
    }

    toggleEditMode() {
        this.store.isEditMode = !this.store.isEditMode;
        const btn = document.getElementById('toggleEdit');
        if (this.store.isEditMode) {
            btn.textContent = 'Add Mode: ON';
            btn.classList.add('devorise-btn-primary');
            btn.classList.remove('devorise-btn-secondary');
            this.mapService.setCursor('crosshair');
        } else {
            btn.textContent = 'Add Mode: OFF';
            btn.classList.add('devorise-btn-secondary');
            btn.classList.remove('devorise-btn-primary');
            this.mapService.setCursor('grab');
        }
    }

    handleMapClick(e) {
        if (!this.store.isEditMode) return;
        this.store.pendingCoords = [e.latlng.lat, e.latlng.lng];
        document.getElementById('modalStopId').value = `P${this.store.points.length + 1}`;
        this.ui.showModal('addStopModal');
    }

    confirmAddStopModal() {
        if (!this.store.pendingCoords) return;
        const id = document.getElementById('modalStopId').value || `P${this.store.points.length + 1}`;
        const w = document.getElementById('modalStopWeight').value || 100;

        this.store.addPoint({
            id: id,
            lat: this.store.pendingCoords[0],
            lng: this.store.pendingCoords[1],
            weight_kg: Number(w)
        });

        this.mapService.updateMarkers(this.store.points);
        this.ui.updateOverallStats(this.store.points.length, this.store.optResult, this.getNumTrucks());
        this.ui.hideModal('addStopModal');
        this.store.pendingCoords = null;
        this.ui.showToast(`✅ Added stop ${id}`);
    }

    async addStopFromForm() {
        const id = document.getElementById('stop-id-input').value || `N-${this.store.points.length + 1}`;
        const w = document.getElementById('stop-weight-input').value || 100;
        const input = document.getElementById('stop-address-input');

        let lat, lng;
        if (input.dataset.lat) {
            lat = Number(input.dataset.lat);
            lng = Number(input.dataset.lng);
        } else {
            try {
                const loc = await APIService.geocode(input.value);
                lat = loc.lat; lng = loc.lng;
            } catch (e) {
                this.ui.showToast("Location not found");
                return;
            }
        }

        this.store.addPoint({ id, lat, lng, weight_kg: Number(w) });
        this.ui.renderStopsTable(this.store.points);
        this.ui.updateOverallStats(this.store.points.length, this.store.optResult, this.getNumTrucks());
        this.mapService.updateMarkers(this.store.points);

        // Reset Inputs
        document.getElementById('stop-id-input').value = '';
        input.value = '';
        delete input.dataset.lat;
    }

    async searchAddress() {
        const input = document.getElementById('stop-address-input');
        const btn = document.getElementById('search-address-btn');
        btn.innerHTML = '...';
        try {
            const loc = await APIService.geocode(input.value);
            input.dataset.lat = loc.lat;
            input.dataset.lng = loc.lng;
            input.value = `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}`;
        } catch (e) {
            this.ui.showToast("Address not found");
        }
        btn.innerHTML = '<i data-lucide="search" style="width:16px;height:16px;"></i>';
        lucide.createIcons();
    }

    addRandomPoints() {
        const count = 50;
        const minW = 4000, maxW = 4500;
        const targetTotal = Math.floor(Math.random() * (maxW - minW) + minW);

        // Generate weights
        let weights = Array.from({ length: count }, () => Math.random() * 90 + 10);
        const sum = weights.reduce((a, b) => a + b, 0);
        weights = weights.map(w => Math.floor(w * (targetTotal / sum)));

        // Generate locations (Nashville)
        for (let i = 0; i < count; i++) {
            this.store.addPoint({
                id: `P${this.store.points.length + 1}`,
                lat: 35.80 + Math.random() * (36.50 - 35.80),
                lng: -87.20 + Math.random() * (-86.30 - -87.20),
                weight_kg: weights[i]
            });
        }

        this.mapService.updateMarkers(this.store.points);
        this.ui.updateOverallStats(this.store.points.length, this.store.optResult, this.getNumTrucks());
        this.ui.showToast(`✨ Added 50 points around Nashville!`);
    }

    async generatePlan() {
        if (this.store.points.length === 0) return this.ui.showToast("Add points first!");

        const startTime = performance.now();
        this.ui.showLoader("Optimizing Routes...");
        try {
            const numTrucks = this.getNumTrucks();
            const result = await APIService.optimizeRoutes(this.store.points, numTrucks);

            // Render first to verify UI performance
            this.mapService.drawRoutes(result.routes, this.store.points);
            this.ui.renderTimeline(result);
            this.ui.updateOverallStats(this.store.points.length, result, numTrucks);

            // Calculate total time including network and rendering
            const endTime = performance.now();
            result.frontend_total_time_ms = endTime - startTime;

            this.store.saveOptResult(result);
            this.ui.showToast("✅ Optimization Complete!");
        } catch (e) {
            console.error(e);
            this.ui.showToast(`❌ Optimization Failed: ${e.message || e}`);
        } finally {
            this.ui.hideLoader();
        }
    }

    clearRoutes() {
        this.store.clearOptResult();
        this.mapService.clearRoutes();
        this.mapService.updateMarkers(this.store.points); // Restore opacity
        this.ui.renderTimeline(null);
        this.ui.updateOverallStats(this.store.points.length, null, this.getNumTrucks());
    }

    resetAll() {
        this.pendingAction = () => {
            this.store.clearPoints();
            this.store.clearOptResult();
            this.mapService.clearRoutes();
            this.mapService.updateMarkers([]);
            this.ui.renderStopsTable([]);
            this.ui.renderTimeline(null);
            this.ui.updateOverallStats(0, null, this.getNumTrucks());
            this.ui.showToast("🗑️ System Reset");
        };
        document.getElementById('confirmMessage').textContent = "This will remove all points and routes. Are you sure?";
        this.ui.showModal('confirmModal');
    }

    executeConfirmAction() {
        if (this.pendingAction) this.pendingAction();
        this.ui.hideModal('confirmModal');
        this.pendingAction = null;
    }

    removeStop(idx) {
        this.store.removePoint(idx);
        this.ui.renderStopsTable(this.store.points);
        this.mapService.updateMarkers(this.store.points);
        this.ui.updateOverallStats(this.store.points.length, this.store.optResult, this.getNumTrucks());
    }

    updateWeight(idx, val) {
        this.store.updatePointWeight(idx, val);
    }

    zoomToStop(lat, lng) {
        this.switchView('dashboard');
        this.mapService.zoomTo(lat, lng);
    }

    getNumTrucks() {
        return parseInt(document.getElementById('numTrucks')?.value) || 2;
    }

    async startHealthCheck() {
        const dot = document.getElementById('ai-status-dot');
        const check = async () => {
            try {
                await APIService.checkHealth();
                dot.classList.add('online');
                dot.classList.remove('offline');
            } catch {
                dot.classList.add('offline');
                dot.classList.remove('online');
            }
        };
        setInterval(check, 15000);
        check();
    }
}

// ==========================================
// 7. BOOTSTRAP
// ==========================================

window.app = new App();
window.addEventListener('load', () => window.app.init());

// Helper for card expansion (legacy support or keep?)
// Keeping it simple as global for onclick in HTML if needed, or bind in UI
window.toggleRouteCard = function () {
    const card = document.getElementById('routeCard');
    const icon = document.getElementById('expandIcon');
    if (!card || !icon) return;

    card.classList.toggle('expanded');
    const expanded = card.classList.contains('expanded');
    document.body.classList.toggle('route-expanded', expanded);

    const nextIcon = expanded ? 'minimize-2' : 'maximize-2';
    icon.setAttribute('data-lucide', nextIcon);

    if (icon.tagName.toLowerCase() === 'svg') {
        const replacement = document.createElement('i');
        replacement.setAttribute('data-lucide', nextIcon);
        replacement.id = 'expandIcon';
        replacement.className = icon.getAttribute('class') || '';
        replacement.style.cssText = icon.getAttribute('style') || '';
        icon.replaceWith(replacement);
    }

    lucide.createIcons();
};
