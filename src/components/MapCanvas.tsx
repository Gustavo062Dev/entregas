import { useId, useMemo, useState } from 'react';
import { ArrowUpRight, LocateFixed, MapPin, Minus, Plus } from 'lucide-react';
import type { Delivery, Driver } from '../types';
import { driverStatusLabel } from '../types';
import './map.css';

export interface MapCanvasProps {
  drivers: Driver[];
  deliveries: Delivery[];
  selectedDriverId?: string | null;
  onSelectDriver?: (id: string) => void;
  activeDeliveryId?: string | null;
  compact?: boolean;
}

const streets = [
  'M-60 126 C165 87 217 177 384 132 S688 51 1050 106',
  'M-60 212 C156 173 274 253 463 216 S795 124 1050 195',
  'M-30 306 C121 271 242 337 422 297 S733 220 1050 278',
  'M-30 388 C151 349 270 426 474 373 S749 305 1040 365',
  'M-30 481 C160 448 256 506 449 465 S794 402 1060 446',
  'M-30 570 C139 530 318 603 514 548 S829 499 1050 530',
  'M130 -30 C87 138 186 223 143 355 S123 530 174 680',
  'M263 -30 C213 133 302 198 267 338 S230 550 291 680',
  'M384 -30 C346 103 414 191 389 337 S357 548 413 680',
  'M502 -30 C473 92 532 179 515 315 S478 493 529 680',
  'M636 -30 C590 105 673 191 638 323 S620 519 666 680',
  'M773 -30 C730 104 797 172 776 306 S740 512 809 680',
  'M904 -30 C849 113 934 194 898 345 S891 523 941 680',
];

const smallStreets = [
  'M-20 77 C191 47 321 94 542 47 S830 8 1010 36',
  'M0 167 C161 142 312 205 490 172 S794 94 1030 148',
  'M0 256 C155 234 313 290 482 256 S775 174 1010 233',
  'M0 346 C148 315 316 378 477 334 S782 266 1010 317',
  'M0 430 C149 400 309 463 465 419 S756 353 1030 406',
  'M0 525 C147 487 316 556 487 510 S774 455 1020 489',
  'M0 619 C159 581 311 647 500 600 S806 552 1020 585',
  'M65 -10 C26 158 100 237 73 377 S55 548 109 650',
  'M197 -10 C162 115 233 211 202 354 S175 537 230 650',
  'M326 -10 C282 108 358 208 327 338 S304 539 351 650',
  'M444 -10 C408 107 470 179 450 326 S421 527 472 650',
  'M570 -10 C525 105 602 177 571 322 S548 532 600 650',
  'M704 -10 C660 94 738 179 707 319 S680 516 738 650',
  'M835 -10 C797 101 868 176 841 327 S814 526 869 650',
  'M968 -10 C919 92 1003 194 967 347 S956 527 996 650',
];

function routeBetween(driver: Driver, delivery: Delivery) {
  const x1 = driver.position.x * 10;
  const y1 = driver.position.y * 6.4;
  const x2 = delivery.position.x * 10;
  const y2 = delivery.position.y * 6.4;
  const bend = (x2 - x1) * 0.6;
  return `M${x1} ${y1} C${x1 + bend} ${y1 - 12}, ${x2 - bend} ${y2 + 20}, ${x2} ${y2}`;
}

export default function MapCanvas({ drivers, deliveries, selectedDriverId, onSelectDriver, activeDeliveryId, compact = false }: MapCanvasProps) {
  const [zoom, setZoom] = useState(1);
  const id = useId().replace(/:/g, '');
  const activeDelivery = deliveries.find((delivery) => delivery.id === activeDeliveryId);
  const selected = drivers.find((driver) => driver.id === selectedDriverId)
    ?? drivers.find((driver) => driver.id === activeDelivery?.driverId)
    ?? drivers.find((driver) => driver.status === 'on_route');
  const visibleDeliveries = useMemo(() => deliveries.filter((delivery) => delivery.status !== 'delivered' || delivery.id === activeDeliveryId), [deliveries, activeDeliveryId]);
  const routes = activeDelivery && selected ? [activeDelivery] : visibleDeliveries.filter((delivery) => delivery.driverId === selected?.id && delivery.status === 'in_transit');

  return (
    <div className={`rota-map${compact ? ' rota-map--compact' : ''}`} aria-label="Mapa ilustrativo da operação de entregas em São Paulo">
      <div className="rota-map-stage" style={{ transform: `scale(${zoom})` }}>
        <svg className="rota-map-svg" viewBox="0 0 1000 640" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <pattern id={`${id}-blocks`} width="38" height="32" patternUnits="userSpaceOnUse" patternTransform="rotate(-8)">
              <rect x="3" y="3" width="30" height="23" rx="3" fill="#e8e8e4" />
              <path d="M7 7 H29 V22 H7 Z" fill="#edede9" />
            </pattern>
            <linearGradient id={`${id}-water`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#c5dde2" />
              <stop offset="100%" stopColor="#d8e8eb" />
            </linearGradient>
          </defs>
          <rect width="1000" height="640" fill="#f0efeb" />
          <rect width="1000" height="640" fill={`url(#${id}-blocks)`} opacity="0.6" />
          <path d="M0 0H136L95 91L111 171L70 260L59 351L5 452H0Z" fill="#dce7d5" />
          <path d="M626 505C659 477 715 469 758 491L782 544L751 615L689 632L637 593L612 548Z" fill="#dae7d3" />
          <path d="M572 28L635 16L668 74L639 118L589 105L568 67Z" fill="#dfe9d9" />
          <path d="M257 80L302 63L328 110L315 144L276 151L250 118Z" fill="#dce8d5" />
          <path d="M905 45L956 27L1000 40V123L955 134L916 101Z" fill="#dce8d5" />
          <g stroke="#f9f9f6" strokeWidth="5" fill="none" strokeLinecap="round">
            {smallStreets.map((street, index) => <path key={index} d={street} />)}
          </g>
          <g stroke="#deded8" strokeWidth="12" fill="none" strokeLinecap="round">
            {streets.map((street, index) => <path key={index} d={street} />)}
          </g>
          <g stroke="#fdfdfb" strokeWidth="9" fill="none" strokeLinecap="round">
            {streets.map((street, index) => <path key={index} d={street} />)}
          </g>
          <path d="M-45 473C119 415 276 405 405 342S668 168 1050 141" fill="none" stroke="#dddbcf" strokeWidth="21" />
          <path d="M-45 473C119 415 276 405 405 342S668 168 1050 141" fill="none" stroke="#fffbeb" strokeWidth="16" />
          <path d="M296 -30C300 90 361 186 485 301S774 481 1015 670" fill="none" stroke="#dfdcd0" strokeWidth="17" />
          <path d="M296 -30C300 90 361 186 485 301S774 481 1015 670" fill="none" stroke="#fffbed" strokeWidth="12" />
          <path d="M-16 -40C112 29 31 155 73 255S34 458 -35 560" fill="none" stroke="#ecf2e8" strokeWidth="54" />
          <path d="M-16 -40C112 29 31 155 73 255S34 458 -35 560" fill="none" stroke={`url(#${id}-water)`} strokeWidth="31" />
          <path d="M-15 -40C114 29 31 155 73 255S34 458 -35 560" fill="none" stroke="#b6d2d9" strokeWidth="1" />
          <g fill="none" stroke="#bfd0b6" strokeWidth="2" opacity="0.8">
            <path d="M653 513L730 500L753 543L732 590L689 610L651 575Z" strokeDasharray="3 5" />
            <path d="M577 53L623 38L646 70L626 96L590 88Z" strokeDasharray="3 5" />
          </g>
          <g className="rota-map-neighborhoods">
            <text x="235" y="214">VILA MADALENA</text>
            <text x="288" y="409">PINHEIROS</text>
            {!compact && <><text x="480" y="128">PERDIZES</text><text x="666" y="256">HIGIENÓPOLIS</text></>}
            <text x="814" y="215">CENTRO</text>
            <text x="694" y="397">BELA VISTA</text>
            <text x="528" y="503">JARDIM PAULISTA</text>
            {!compact && <><text x="396" y="584">ITAIM BIBI</text><text x="890" y="511">LIBERDADE</text><text x="827" y="77">BOM RETIRO</text></>}
          </g>
          <g className="rota-map-streetnames">
            <text x="378" y="365" transform="rotate(-29 378 365)">Av. Rebouças</text>
            <text x="580" y="379" transform="rotate(32 580 379)">Av. Paulista</text>
            {!compact && <><text x="415" y="245" transform="rotate(-8 415 245)">R. Heitor Penteado</text><text x="682" y="559">Parque Ibirapuera</text></>}
          </g>
          {routes.map((delivery) => selected && (
            <g key={delivery.id}>
              <path d={routeBetween(selected, delivery)} fill="none" stroke="#ffffff" strokeWidth="12" strokeLinecap="round" />
              <path d={routeBetween(selected, delivery)} fill="none" stroke="#7260de" strokeWidth="6" strokeLinecap="round" />
              <path d={routeBetween(selected, delivery)} fill="none" stroke="#b1a5ff" strokeWidth="2" strokeDasharray="1 15" strokeLinecap="round" />
            </g>
          ))}
        </svg>
        {visibleDeliveries.map((delivery, index) => (
          <div key={delivery.id} className={`rota-map-destination${delivery.id === activeDeliveryId ? ' rota-map-destination--active' : ''}`} style={{ left: `${delivery.position.x}%`, top: `${delivery.position.y}%` }} title={`${delivery.customer} · ${delivery.address}`} aria-label={`Destino: ${delivery.customer}, ${delivery.address}`}>
            {delivery.id === activeDeliveryId ? <MapPin size={17} /> : <span>{index + 1}</span>}
          </div>
        ))}
        {drivers.map((driver) => {
          const isSelected = driver.id === selected?.id;
          return (
            <div key={driver.id} className={`rota-map-driver-position${isSelected ? ' rota-map-driver-position--selected' : ''}`} style={{ left: `${driver.position.x}%`, top: `${driver.position.y}%` }}>
              {isSelected && <span className="rota-map-driver-halo" />}
              <button type="button" className={`rota-map-driver rota-map-driver--${driver.status}`} style={{ backgroundColor: driver.color }} aria-label={`${driver.name}, ${driverStatusLabel[driver.status]}`} aria-pressed={isSelected} onClick={() => onSelectDriver?.(driver.id)} title={`${driver.name} · ${driverStatusLabel[driver.status]}`}>
                <span>{driver.initials}</span>
                {driver.status === 'on_route' && <span className="rota-map-direction"><ArrowUpRight size={10} strokeWidth={3} /></span>}
              </button>
              {isSelected && !compact && <span className="rota-map-driver-name">{driver.name.split(' ')[0]}<span className={`rota-map-driver-name-dot rota-map-driver-name-dot--${driver.status}`} /></span>}
            </div>
          );
        })}
      </div>
      {!compact && <div className="rota-map-city"><MapPin size={13} /> São Paulo, SP</div>}
      <div className="rota-map-controls" aria-label="Controles do mapa">
        <button type="button" aria-label="Ampliar mapa" onClick={() => setZoom((value) => Math.min(2, Math.round((value + 0.2) * 10) / 10))} disabled={zoom >= 2}><Plus size={17} /></button>
        <button type="button" aria-label="Reduzir mapa" onClick={() => setZoom((value) => Math.max(1, Math.round((value - 0.2) * 10) / 10))} disabled={zoom <= 1}><Minus size={17} /></button>
        <button type="button" aria-label="Restaurar visão do mapa" onClick={() => setZoom(1)}><LocateFixed size={16} /></button>
      </div>
      <div className="rota-map-attribution">Mapa ilustrativo <span>·</span> dados de demonstração</div>
    </div>
  );
}
