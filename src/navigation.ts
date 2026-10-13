export function driverScreen(location = window.location) {
  return location.pathname.startsWith('/entregador') || new URLSearchParams(location.search).get('tela') === 'entregador';
}

export function screenHref(screen: 'admin' | 'driver', location = window.location) {
  if (location.protocol !== 'file:' && import.meta.env.MODE !== 'portable') return screen === 'driver' ? '/entregador' : '/';
  const url = new URL(location.href);
  url.search = screen === 'driver' ? '?tela=entregador' : '';
  url.hash = '';
  return url.href;
}
