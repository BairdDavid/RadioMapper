// This function runs when the DOM is fully loaded
document.addEventListener('DOMContentLoaded', function () {

    // --- GLOBAL VARIABLES ---
    let allData = [];
    let initialHeaderData = {};
    let heatLayer = null;
    let pointMarkerLayer = L.layerGroup();
    let rssiRangeSlider = null;
    let rssiLimitsSlider = null;
    let liveSocket = null;
    let liveActive = false;
    let latestFix = null;
    let latestUhf = null;
    let seenPackets = new Set();
    let liveMapFitted = false;
    let liveSessionId = 0;
    let rangeFollowsData = true;
    let timeFollowsData = true;
    const MARKER_VISIBILITY_ZOOM_LEVEL = 18;
    const UHF_TOPIC = '{groupId}/event/diag/uhf/info';
    const GNSS_TOPIC = '{groupId}/event/diag/gnss/data/primary';

    // --- MAP INITIALIZATION ---
    
    const streetMap = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    });
    const satelliteMap = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
    });
    
    const map = L.map('map', { center: [20, 0], zoom: 2, layers: [streetMap] });
    
    const baseMaps = { "Map": streetMap, "Satellite": satelliteMap };
    L.control.layers(baseMaps).addTo(map);

    map.on('zoomend', togglePointMarkers);

    const heatGradient = {
        0.0: 'red',
        0.45: 'red',
        0.75: 'yellow',
		0.95: 'green',
        1.0: 'green'
    };
    
    heatLayer = L.heatLayer([], {
        radius: 30,
        blur: 15, 
        gradient: heatGradient,
        max: 1.0,
        minOpacity: 0.5
    }).addTo(map);

    // --- EVENT LISTENERS ---
    document.getElementById('upload-btn').addEventListener('click', () => document.getElementById('csv-upload').click());
    document.getElementById('csv-upload').addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (file) parseCSV(file);
    });
    document.getElementById('clear-btn').addEventListener('click', clearAll);
    document.getElementById('live-start-btn').addEventListener('click', startLive);
    document.getElementById('live-stop-btn').addEventListener('click', stopLive);
    document.getElementById('apply-filter-btn').addEventListener('click', applyFilters);
    document.getElementById('reset-filter-btn').addEventListener('click', () => {
        populateFilters(initialHeaderData, allData);
        applyFilters();
    });

    // --- DATA HANDLING AND PROCESSING ---
    
    function parseCSV(file) {
        const reader = new FileReader();
        reader.onload = function (e) {
            const lines = e.target.result.split('\n');
            const headerData = {}, dataRows = [];
            let columnHeaders = [], inHeaderSection = true;

            lines.forEach(line => {
                const trimmedLine = line.trim();
                if (trimmedLine.startsWith('#')) {
                    const parts = trimmedLine.substring(1).split(':');
                    const key = parts[0].trim();
                    const value = parts.slice(1).join(':').split(',')[0].trim();
                    if (!headerData[key]) headerData[key] = [];
                    headerData[key].push(value);
                } else if (inHeaderSection && trimmedLine !== '') {
                    columnHeaders = trimmedLine.split(',').map(h => h.trim());
                    inHeaderSection = false;
                } else if (trimmedLine !== '') {
                    dataRows.push(trimmedLine.split(','));
                }
            });
            initialHeaderData = headerData;
            processData(initialHeaderData, columnHeaders, dataRows);
        };
        reader.readAsText(file);
    }

    function processData(headerData, columnHeaders, data) {
        clearAll(true);
        const latIndex = columnHeaders.indexOf('Lat'), lonIndex = columnHeaders.indexOf('Lon'),
              rssiIndex = columnHeaders.indexOf('RSSI'), dateIndex = columnHeaders.indexOf('Date'),
              timeIndex = columnHeaders.indexOf('Time');

        if (latIndex === -1 || lonIndex === -1 || rssiIndex === -1) {
            return alert('CSV must contain "Lat", "Lon, and "RSSI" columns.');
        }

        allData = data.map(row => {
            let timestamp = null, dateStr = row[dateIndex] || '', timeStr = row[timeIndex] || '';
            if (dateIndex !== -1 && timeIndex !== -1) {
                const dateParts = dateStr.split('/'), timeParts = timeStr.split(':');
                if (dateParts.length === 3 && timeParts.length === 3) {
                    timestamp = Date.UTC(dateParts[2], dateParts[0] - 1, dateParts[1], timeParts[0], timeParts[1], timeParts[2]);
                }
            }
            return {
                lat: convertToDecimalDegrees(row[latIndex]), lon: convertToDecimalDegrees(row[lonIndex]),
                rssi: parseFloat(row[rssiIndex]), timestamp: timestamp,
                dateStr: dateStr, timeStr: timeStr
            };
        }).filter(d => !isNaN(d.lat) && !isNaN(d.lon) && !isNaN(d.rssi) && d.timestamp !== null);
        
        if (allData.length > 0) {
            populateFilters(headerData, allData);
            applyFilters();
            map.fitBounds(L.latLngBounds(allData.map(p => [p.lat, p.lon])).pad(0.1));
        } else {
            alert('No valid data points found. Please check file format.');
        }
    }

    function convertToDecimalDegrees(coordStr) {
		if (!coordStr || typeof coordStr !== 'string') return NaN;
		const coord = coordStr.replace(',', '.');
		if (!isNaN(parseFloat(coord)) && isFinite(coord)) {
			return parseFloat(coord);
		}
		const parts = coord.split('.');
		if (isNaN(parts[0])) return NaN;
		
		const degrees = parseInt(parts[0], 10);
		let decimalDegrees = 0;
	
		if (parts.length >= 3) {
			const minutes = parseInt(parts[1], 10);
			const secondsStr = parts.slice(2).join('');
			const seconds = parseFloat(secondsStr.slice(0, 2) + '.' + secondsStr.slice(2));
			if (isNaN(minutes) || isNaN(seconds)) return NaN;
			decimalDegrees = Math.abs(degrees) + minutes / 60.0 + seconds / 3600.0;
		} else {
			return parseFloat(coord);
		}
		
		return degrees < 0 ? -decimalDegrees : decimalDegrees;
	}

    // --- UI AND FILTERING LOGIC ---

    function populateFilters(headerData, data) {
        const filtersContainer = document.getElementById('filters-container');
        const infoContainer = document.getElementById('info-container');
        
        filtersContainer.querySelectorAll('.dynamic-filter').forEach(el => el.remove());
        infoContainer.innerHTML = '';
        
        const timestamps = data.map(d => d.timestamp).filter(t => t);
        const rssiValues = data.map(d => d.rssi);
        const ignoredHeaders = [ 'Model', 'Receiver ID', 'Description', 'Max good PDOP', 'Max okay PDOP', 'Max good HorErr', 'Max okay HorErr', 'Max good VertErr', 'Max okay VertErr', 'Max good RSSI', 'Max okay RSSI' ];
        const limitsContainer = document.getElementById('rssi-limits-container');

        const model = headerData['Model'] ? headerData['Model'].join(', ') : 'unknown';
        const receiverId = headerData['Receiver ID'] ? headerData['Receiver ID'].join(', ') : 'unknown';
        const description = headerData['Description'] ? headerData['Description'].join(', ') : 'unknown';
        infoContainer.innerHTML += `<p><strong>Model:</strong> ${model}</p><p><strong>Receiver ID:</strong> ${receiverId}</p><p><strong>Description:</strong> ${description}</p>`;

        if (timestamps.length > 0) {
            const minDate = Math.min(...timestamps);
            const maxDate = Math.max(...timestamps);
            filtersContainer.insertAdjacentHTML('afterbegin', createInputFilter('End Time', 'end-time', 'datetime-local', toUtcMinuteInput(maxDate)));
            filtersContainer.insertAdjacentHTML('afterbegin', createInputFilter('Start Time', 'start-time', 'datetime-local', toUtcMinuteInput(minDate)));
            ['start-time', 'end-time'].forEach(id => {
                const input = document.getElementById(id);
                if (input) input.addEventListener('change', () => { timeFollowsData = false; });
            });
        }
        timeFollowsData = true;

        for (const key in headerData) {
            if (!ignoredHeaders.includes(key)) {
                const newFilter = (headerData[key].length > 1)
                    ? createSelectFilter(key, key.toLowerCase().replace(/\s/g, '-'), headerData[key])
                    : createInputFilter(key, key.toLowerCase().replace(/\s/g, '-'), 'text', headerData[key][0]);
                limitsContainer.insertAdjacentHTML('beforebegin', newFilter);
            }
        }

        const limitGood = parseFloat(headerData['Max good RSSI']?.[0] || -90);
        const limitBad = parseFloat(headerData['Max okay RSSI']?.[0] || -114);
        const limitsSliderEl = document.getElementById('rssi-limits-slider');
        if (limitsSliderEl.noUiSlider) limitsSliderEl.noUiSlider.destroy();
        rssiLimitsSlider = noUiSlider.create(limitsSliderEl, {
            start: [limitBad, limitGood], connect: true, tooltips: false, direction: 'rtl',
            format: { to: v => Math.round(v), from: v => Number(v) },
            range: { 'min': -200, 'max': 0 }, step: 1, margin: 1
        });
        
        rssiLimitsSlider.on('update', (values) => {
            document.getElementById('rssi-limits-best-label').innerHTML = Math.round(values[1]);
            document.getElementById('rssi-limits-worst-label').innerHTML = Math.round(values[0]);
        });
        
        let bestRssi = Math.ceil(Math.max(...rssiValues)), worstRssi = Math.floor(Math.min(...rssiValues));
        if (bestRssi - worstRssi < 1) {
            worstRssi = Math.max(-200, bestRssi - 1);
            if (bestRssi - worstRssi < 1) bestRssi = Math.min(0, worstRssi + 1);
        }
        const rangeSliderEl = document.getElementById('rssi-range-slider');
        if (rangeSliderEl.noUiSlider) rangeSliderEl.noUiSlider.destroy();
        rssiRangeSlider = noUiSlider.create(rangeSliderEl, {
            start: [worstRssi, bestRssi], connect: true, tooltips: false, direction: 'rtl',
            format: { to: v => Math.round(v), from: v => Number(v) },
            range: { 'min': -200, 'max': 0 }, step: 1, margin: 1
        });

        rssiRangeSlider.on('update', (values) => {
            document.getElementById('rssi-range-best-label').innerHTML = Math.round(values[1]);
            document.getElementById('rssi-range-worst-label').innerHTML = Math.round(values[0]);
        });
        rssiRangeSlider.on('change', () => { rangeFollowsData = false; });
        rangeFollowsData = true;

        document.getElementById('info-section').classList.remove('hidden');
        document.getElementById('filter-section').classList.remove('hidden');
    }

    function applyFilters() {
        if (allData.length === 0) return;
        
        const getTimestamp = (id, def) => {
            const i = document.getElementById(id);
            return (!i || !i.value) ? def : new Date(i.value + 'Z').getTime();
        };

        const startTime = getTimestamp('start-time', 0);
        const endInput = document.getElementById('end-time');
        const endTime = (!endInput || !endInput.value)
            ? Date.now() + 864e5
            : new Date(endInput.value + 'Z').getTime() + 59999;
        const [maxRssi, minRssi] = rssiRangeSlider.get();
        
        const filteredData = allData.filter(d => 
            (d.timestamp >= startTime && d.timestamp <= endTime) &&
            (d.rssi >= maxRssi && d.rssi <= minRssi)
        );
        
        updateMap(filteredData);
    }

    // --- UI AND MAP UPDATE FUNCTIONS ---

    function clearAll(keepInitialData = false) {
        stopLive();
        liveMapFitted = false;
        if (heatLayer) heatLayer.setLatLngs([]);
        if (pointMarkerLayer) pointMarkerLayer.clearLayers();
        document.getElementById('filters-container').querySelectorAll('.dynamic-filter').forEach(el => el.remove());
        document.getElementById('info-container').innerHTML = '';
        
        if(rssiRangeSlider) { rssiRangeSlider.destroy(); rssiRangeSlider = null; }
        if(rssiLimitsSlider) { rssiLimitsSlider.destroy(); rssiLimitsSlider = null; }
        
        document.getElementById('info-section').classList.add('hidden');
        document.getElementById('filter-section').classList.add('hidden');
        allData = [];

        if (!keepInitialData) initialHeaderData = {};
    }

    // REPLACE the entire updateMap function with this one
	function updateMap(data) {
		heatLayer.setLatLngs([]);
		pointMarkerLayer.clearLayers();
	
		if (data.length === 0) {
			return;
		}
	
		const [limitWeak, limitGood] = rssiLimitsSlider.get();
		const colorRange = limitGood - limitWeak;
		
		const heatPoints = [];
	
		data.forEach(point => {
			// --- Diagnostic Step-by-Step Calculation ---
			
			// 1. Calculate the raw intensity based on the limits
			let initial_intensity = 0;
			if (colorRange > 0) {
				initial_intensity = (point.rssi - limitWeak) / colorRange;
			}
			
			// 2. Clamp the value between 0 and 1
			let clamped_intensity = Math.max(0, Math.min(initial_intensity, 1));
	
			// 3. Apply your remapping formula
			let final_intensity = clamped_intensity / 2 + 0.5;
	
			heatPoints.push([point.lat, point.lon, final_intensity]);
	
			const marker = L.circleMarker([point.lat, point.lon], {
				radius: 5,
				color: '#FFFFFF',
				weight: 1.5,
				fillColor: '#333333',
				fillOpacity: 0.7
			});
			
			let popupHtml = `<b>RSSI:</b> ${point.rssi} dBm<br>`;
			if (Number.isFinite(point.noise)) popupHtml += `<b>Noise:</b> ${point.noise} dBm<br>`;
			if (point.packetCount != null && point.packetCount !== '') popupHtml += `<b>Packet:</b> ${escapeHtml(point.packetCount)}<br>`;
			if (point.dateStr || point.timeStr) popupHtml += `<b>Time:</b> ${escapeHtml(`${point.dateStr} ${point.timeStr}`.trim())}<br>`;
			popupHtml += `<b>Limits Used:</b> [${limitWeak}, ${limitGood}]<br>` +
				`<b>Initial Intensity:</b> ${initial_intensity.toFixed(3)}<br>` +
				`<b>Clamped Intensity:</b> ${clamped_intensity.toFixed(3)}<br>` +
				`<b>Final Intensity:</b> ${final_intensity.toFixed(3)}`;
			marker.bindPopup(popupHtml);
			
			pointMarkerLayer.addLayer(marker);
		});
		
		if (heatPoints.length > 0) {
			// The calibration points are still needed
			heatPoints.push([-89.9, -179.9, 0.0000000001]); // Absolute Minimum (non-zero)
			heatPoints.push([89.9, 179.9, 1.0]);              // Absolute Maximum
		}
	
		heatLayer.setLatLngs(heatPoints);
		togglePointMarkers();
	}
    
    function togglePointMarkers() {
        const currentZoom = map.getZoom();
        if (currentZoom >= MARKER_VISIBILITY_ZOOM_LEVEL) {
            if (!map.hasLayer(pointMarkerLayer)) {
                map.addLayer(pointMarkerLayer);
            }
        } else {
            if (map.hasLayer(pointMarkerLayer)) {
                map.removeLayer(pointMarkerLayer);
            }
        }
    }

    // --- LIVE RECEIVER ---

    function startLive() {
        const hostInput = document.getElementById('live-host');
        const host = normalizeHost(hostInput.value);
        if (!host) {
            setLiveStatus('Enter a receiver host.');
            return;
        }
        hostInput.value = host;
        closeLiveSocket();
        latestFix = null;
        latestUhf = null;
        seenPackets.clear();
        liveMapFitted = false;
        const session = ++liveSessionId;
        liveActive = true;
        setLiveRunning(true);
        setLiveStatus('Connecting…');

        if (typeof io !== 'function') {
            liveActive = false;
            setLiveRunning(false);
            setLiveStatus('Socket.IO failed to load.');
            return;
        }

        requestGuestAuth(host).then((auth) => {
            if (session !== liveSessionId) return;
            openLiveSocket(host, auth);
        }).catch(() => {
            if (session !== liveSessionId) return;
            liveActive = false;
            setLiveRunning(false);
            setLiveStatus('Could not reach the receiver. Open this page with live_server.py.');
        });
    }

    function openLiveSocket(host, auth) {
        const socket = io('https://' + host + '/apps/device/api/v1/ws', {
            path: '/apps/device/api/v1/ws',
            transports: ['websocket'],
            auth: { token: auth.token }
        });
        liveSocket = socket;
        socket.on('connect', subscribeLiveTopics);
        socket.on('connect_error', () => {
            if (liveActive) setLiveStatus('Connection failed. Retrying…');
        });
        socket.on('disconnect', () => {
            if (liveActive) setLiveStatus('Reconnecting…');
        });
        socket.on('judoapi', handleLiveMessage);
    }

    function requestGuestAuth(host) {
        const direct = 'https://' + host + '/apps/device/api/v1/token';
        const proxied = location.origin + '/mp/' + host + '/apps/device/api/v1/token';
        return postGuestAuth(direct).then((token) => ({ token: token, proxied: false }))
            .catch(() => postGuestAuth(proxied).then((token) => ({ token: token, proxied: true })));
    }

    function postGuestAuth(url) {
        const body = new FormData();
        body.append('grant_type', 'password');
        body.append('username', 'guest');
        body.append('password', 'guest');
        body.append('client_id', 'judoid');
        return fetch(url, { method: 'POST', body }).then((response) => {
            if (!response.ok) throw new Error('sign-in failed');
            return response.json();
        }).then((data) => {
            if (!data || !data.access_token) throw new Error('sign-in failed');
            return `${data.token_type || 'Bearer'} ${data.access_token}`;
        });
    }

    function stopLive() {
        closeLiveSocket();
        latestFix = null;
        latestUhf = null;
        seenPackets.clear();
        setLiveRunning(false);
        setLiveStatus('Stopped');
    }

    function closeLiveSocket() {
        liveSessionId += 1;
        liveActive = false;
        const socket = liveSocket;
        liveSocket = null;
        if (!socket) return;
        socket.removeAllListeners();
        socket.disconnect();
    }

    function setLiveRunning(running) {
        document.getElementById('live-start-btn').disabled = running;
        document.getElementById('live-stop-btn').disabled = !running;
        document.getElementById('live-host').disabled = running;
    }

    function setLiveStatus(text) {
        document.getElementById('live-status').textContent = text;
    }

    function subscribeLiveTopics() {
        if (!liveSocket) return;
        [UHF_TOPIC, GNSS_TOPIC].forEach(topic => {
            liveSocket.emit('judoapi', { operation: 'subscribe', topic });
            liveSocket.emit('judoapi', { operation: 'get', topic, payload: {} });
        });
        renderLiveStatus();
    }

    function renderLiveStatus() {
        if (!liveActive) {
            setLiveStatus('Stopped');
            return;
        }
        if (!liveSocket || !liveSocket.connected) {
            setLiveStatus('Connecting…');
            return;
        }
        const rssi = latestUhf ? Number(latestUhf.rssiPacket) : NaN;
        const noise = latestUhf ? Number(latestUhf.rssiNoise) : NaN;
        const parts = [
            'Connected',
            Number.isFinite(rssi) ? `${rssi} dBm` : 'waiting for UHF',
            Number.isFinite(noise) ? `noise ${noise} dBm` : 'noise —',
            latestFix ? (latestFix.mode || 'Fix') : 'waiting for GNSS',
            `${allData.length} point${allData.length === 1 ? '' : 's'}`
        ];
        setLiveStatus(parts.join(' · '));
    }

    function handleLiveMessage(message) {
        if (!liveActive || !message) return;
        const topic = String(message.topic || '');
        let payload = message.payload != null ? message.payload : message;
        if (Array.isArray(payload)) payload = payload[payload.length - 1];
        if (!payload || typeof payload !== 'object') return;

        if (topic.includes('diag/uhf/info')) handleUhf(payload);
        else if (topic.includes('diag/gnss/data/primary')) handleGnss(payload);
    }

    function handleGnss(payload) {
        const lat = Number(payload.lat);
        const lon = Number(payload.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return;
        latestFix = {
            lat: lat,
            lon: lon,
            mode: payload.mode || '',
            deviceId: payload.deviceId || ''
        };
        renderLiveStatus();
    }

    function handleUhf(payload) {
        const rssi = Number(payload.rssiPacket);
        if (!Number.isFinite(rssi)) return;
        const packetCount = payload.packetCount;
        if (packetCount != null && seenPackets.has(packetCount)) return;

        latestUhf = payload;
        renderLiveStatus();
        if (!latestFix) return;
        if (packetCount != null) seenPackets.add(packetCount);

        const parsedTime = Date.parse(payload.timestamp);
        const timestamp = Number.isFinite(parsedTime) ? parsedTime : Date.now();
        const when = new Date(timestamp);
        allData.push({
            lat: latestFix.lat,
            lon: latestFix.lon,
            rssi: rssi,
            timestamp: timestamp,
            dateStr: toUtcMinuteInput(timestamp).slice(0, 10),
            timeStr: when.toISOString().slice(11, 19),
            noise: Number(payload.rssiNoise),
            packetCount: packetCount
        });

        if (!rssiRangeSlider || !rssiLimitsSlider) {
            initialHeaderData = {
                Model: [payload.radioType || 'UHF'],
                'Receiver ID': [payload.deviceId || latestFix.deviceId || 'live'],
                Description: ['Live UHF']
            };
            populateFilters(initialHeaderData, allData);
        } else {
            if (rangeFollowsData) expandLiveRange();
            if (timeFollowsData) extendTimeFilters(timestamp);
        }

        applyFilters();
        if (!liveMapFitted) {
            map.setView([latestFix.lat, latestFix.lon], 16);
            liveMapFitted = true;
        }
        renderLiveStatus();
    }

    function expandLiveRange() {
        if (!rssiRangeSlider || allData.length === 0) return;
        let worst = Math.max(-200, Math.floor(Math.min(...allData.map(d => d.rssi))));
        let best = Math.min(0, Math.ceil(Math.max(...allData.map(d => d.rssi))));
        if (best - worst < 1) {
            worst = Math.max(-200, best - 1);
            if (best - worst < 1) best = Math.min(0, worst + 1);
        }
        const current = rssiRangeSlider.get().map(Number);
        const low = Math.min(current[0], worst);
        const high = Math.max(current[1], best);
        if (low !== current[0] || high !== current[1]) rssiRangeSlider.set([low, high]);
    }

    function extendTimeFilters(timestamp) {
        const minute = toUtcMinuteInput(timestamp);
        const start = document.getElementById('start-time');
        const end = document.getElementById('end-time');
        if (start && minute < start.value) start.value = minute;
        if (end && minute > end.value) end.value = minute;
    }

    function normalizeHost(raw) {
        let host = String(raw || '').trim().replace(/^[a-z]+:\/\//i, '');
        host = host.split('/')[0].split('?')[0];
        return /^[a-z0-9.-]+(?::\d+)?$/i.test(host) ? host : '';
    }

    // --- HELPER FUNCTIONS ---

    function toUtcMinuteInput(timestamp) {
        const date = new Date(timestamp);
        const pad = (n) => n.toString().padStart(2, '0');
        return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
    }

    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[ch]));
    }
    
    function createInputFilter(label, id, type, value) {
        return `<div class="filter-control dynamic-filter"><label for="${id}">${label}</label><input type="${type}" id="${id}" value="${value}"></div>`;
    }

    function createSelectFilter(label, id, options) {
        const optionsHtml = options.map(opt => `<option value="${opt}">${opt}</option>`).join('');
        return `<div class="filter-control dynamic-filter"><label for="${id}">${label}</label><select id="${id}">${optionsHtml}</select></div>`;
    }
});