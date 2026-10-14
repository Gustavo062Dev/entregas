import { useEffect, useRef, useState } from 'react';
import { LocateFixed, MapPin, Minus, Plus } from 'lucide-react';
import type * as Leaflet from 'leaflet';
import type { Driver, GpsPoint } from '../types';
import 'leaflet/dist/leaflet.css';
import './gps-map.css';

interface Props {
  drivers: Driver[];
  selectedDriverId?: string | null;
  onSelectDriver?: (driverId: string) => void;
  compact?: boolean;
}

export function validGps(point?: GpsPoint): point is GpsPoint {
  return Boolean(point && Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90
    && Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180
    && Number.isFinite(point.accuracy) && point.accuracy >= 0 && Number.isFinite(Date.parse(point.recordedAt)));
}

export function gpsAgeLabel(point: GpsPoint, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(point.recordedAt)) / 1000));
  if (seconds < 60) return 'há menos de 1 min';
  if (seconds < 3600) return `há ${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `há ${Math.floor(seconds / 3600)} h`;
  return `há ${Math.floor(seconds / 86400)} dias`;
}

export function gpsIsStale(point: GpsPoint, now = Date.now()) {
  return now - Date.parse(point.recordedAt) > 120_000;
}

export default function GpsMap({ drivers, selectedDriverId, onSelectDriver, compact = false }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Leaflet.Map | null>(null);
  const leafletRef = useRef<typeof Leaflet | null>(null);
  const markers = useRef(new Map<string, Leaflet.Marker>());
  const onSelect = useRef(onSelectDriver);
  onSelect.current = onSelectDriver;
  const [ready, setReady] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [error, setError] = useState('');
  const [tilesUnavailable, setTilesUnavailable] = useState(false);
  const located = drivers.filter(driver => validGps(driver.gps));
  const hasLocations = located.length > 0;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!hasLocations || !container.current) return;
    let cancelled = false;
    let observer: ResizeObserver | undefined;
    setError('');
    setTilesUnavailable(false);
    void import('leaflet').then(L => {
      if (cancelled || !container.current) return;
      leafletRef.current = L;
      const map = L.map(container.current, { zoomControl: false, attributionControl: false, scrollWheelZoom: false });
      mapRef.current = map;
      const configuredUrl = import.meta.env.VITE_MAP_TILE_URL?.trim();
      const tileUrl = configuredUrl || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
      // The map provider must keep HTTPS; no application-managed tile cache or prefetch.
      if (!tileUrl.startsWith('https://')) {
        setError('O provedor do mapa precisa usar HTTPS.');
      } else {
        const tiles = L.tileLayer(tileUrl, { maxZoom: 19, updateWhenIdle: true, keepBuffer: 1 });
        tiles.on('tileerror', () => { if (!cancelled) setTilesUnavailable(true); });
        tiles.on('tileload', () => { if (!cancelled) setTilesUnavailable(false); });
        tiles.addTo(map);
      }
      observer = new ResizeObserver(() => map.invalidateSize());
      observer.observe(container.current);
      setReady(true);
    }).catch(() => { if (!cancelled) setError('Não foi possível abrir o mapa. Tente atualizar a tela.'); });
    return () => {
      cancelled = true;
      observer?.disconnect();
      mapRef.current?.remove();
      mapRef.current = null;
      markers.current.clear();
      setReady(false);
    };
  }, [hasLocations]);

  useEffect(() => {
    const map = mapRef.current;
    const L = leafletRef.current;
    if (!ready || !map || !L) return;
    const visibleIds = new Set(located.map(driver => driver.id));
    for (const [id, marker] of markers.current) {
      if (!visibleIds.has(id)) { marker.remove(); markers.current.delete(id); }
    }
    for (const driver of located) {
      const point = driver.gps!;
      const stale = gpsIsStale(point, now);
      const selected = driver.id === selectedDriverId;
      const iconNode = document.createElement('span');
      iconNode.className = `gps-map-marker${stale ? ' is-stale' : ''}${selected ? ' is-selected' : ''}`;
      iconNode.style.backgroundColor = driver.color;
      iconNode.textContent = driver.initials;
      iconNode.dataset.driverId = driver.id;
      const icon = L.divIcon({ html: iconNode, className: 'gps-map-marker-wrap', iconSize: [38, 38], iconAnchor: [19, 19] });
      const description = `${driver.name} · precisão ±${Math.round(point.accuracy)} m · ${gpsAgeLabel(point, now)}${stale ? ' · localização antiga' : ''}`;
      const tooltip = document.createElement('span');
      tooltip.textContent = description;
      let marker = markers.current.get(driver.id);
      if (!marker) {
        marker = L.marker([point.latitude, point.longitude], { icon, title: description, alt: description });
        marker.on('click', () => onSelect.current?.(driver.id));
        marker.addTo(map);
        markers.current.set(driver.id, marker);
      } else { marker.setLatLng([point.latitude, point.longitude]); marker.setIcon(icon); }
      marker.bindTooltip(tooltip, { direction: 'top', offset: [0, -15] });
      marker.setOpacity(stale ? .65 : 1);
      marker.setZIndexOffset(selected ? 1000 : 0);
      const element = marker.getElement();
      if (element) { element.setAttribute('title', description); element.setAttribute('aria-label', description); }
    }
    if (!Number.isFinite(map.getZoom())) fitMap(map, located);
  }, [drivers, selectedDriverId, now, ready]);

  useEffect(() => {
    const selected = drivers.find(driver => driver.id === selectedDriverId);
    if (ready && selected && validGps(selected.gps)) mapRef.current?.setView([selected.gps.latitude, selected.gps.longitude], 16, { animate: false });
  }, [selectedDriverId, ready]);

  function fitMap(map: Leaflet.Map, currentDrivers: Driver[]) {
    const points = currentDrivers.filter(driver => validGps(driver.gps)).map(driver => [driver.gps!.latitude, driver.gps!.longitude] as [number, number]);
    if (points.length === 1) map.setView(points[0], 16, { animate: false });
    else if (points.length) map.fitBounds(points, { padding: [45, 45], maxZoom: 16, animate: false });
  }

  return <div className={`gps-map${compact ? ' gps-map--compact' : ''}`} aria-label="Mapa das localizações recebidas por GPS">
    <div ref={container} className="gps-map-canvas" />
    {!hasLocations && <div className="gps-map-empty" role="status"><MapPin size={28} /><strong>Aguardando localização</strong><p>Ative o GPS no aplicativo Android durante o turno para aparecer no mapa.</p></div>}
    {hasLocations && !ready && !error && <div className="gps-map-loading" role="status">Abrindo mapa…</div>}
    {(error || tilesUnavailable) && <div className="gps-map-error" role="status">{error || 'Mapa de ruas indisponível. As posições recebidas continuam visíveis.'}</div>}
    {ready && <div className="gps-map-controls" aria-label="Controles do mapa"><button type="button" aria-label="Ampliar mapa" onClick={() => mapRef.current?.zoomIn()}><Plus size={18} /></button><button type="button" aria-label="Reduzir mapa" onClick={() => mapRef.current?.zoomOut()}><Minus size={18} /></button><button type="button" aria-label="Mostrar todas as localizações" onClick={() => { if (mapRef.current) fitMap(mapRef.current, located); }}><LocateFixed size={18} /></button></div>}
    {hasLocations && <div className="gps-map-attribution">{import.meta.env.VITE_MAP_ATTRIBUTION?.trim() && <span>{import.meta.env.VITE_MAP_ATTRIBUTION.trim()} · </span>}© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors</div>}
  </div>;
}
