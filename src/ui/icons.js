export function setIcon(use, name) {
  use.setAttribute('href', `./ui/icons.svg#${name}`);
}

export function icon(name) {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  const use = document.createElementNS(namespace, 'use');
  svg.classList.add('icon');
  svg.setAttribute('aria-hidden', 'true');
  setIcon(use, name);
  svg.append(use);
  return svg;
}
