console.log('fixture ready');
console.warn('fixture warning');

const status = document.getElementById('status');
const helloButton = document.getElementById('hello-button');
const form = document.getElementById('profile-form');
const nameInput = document.getElementById('name-input');
const choice = document.getElementById('choice-select');
const dragSource = document.getElementById('drag-source');
const dropTarget = document.getElementById('drop-target');

let helloCount = 0;
let dragging = false;

helloButton.addEventListener('click', () => {
  helloCount += 1;
  status.textContent = `Hello ${helloCount}.`;
  console.log(`hello ${helloCount}`);
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = nameInput.value.trim() || 'nobody';
  status.textContent = `Saved ${name}.`;
  console.log(`saved ${name}; colour ${choice.value || 'none'}`);
});

dragSource.addEventListener('mousedown', () => {
  dragging = true;
  status.textContent = 'Dragging.';
});

document.addEventListener('mouseup', (event) => {
  if (!dragging) return;
  dragging = false;
  const under = document.elementFromPoint(event.clientX, event.clientY);
  if (under && under.closest('#drop-target')) {
    dropTarget.classList.add('dropped');
    dropTarget.textContent = 'Dropped: payload';
    status.textContent = 'Drag complete.';
    console.log('drag complete');
  } else {
    status.textContent = 'Drag cancelled.';
  }
});

class ShadowWidget extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'open' });
    const button = document.createElement('button');
    button.textContent = 'Shadow action';
    button.type = 'button';
    button.addEventListener('click', () => {
      status.textContent = 'Shadow action pressed.';
      console.log('shadow action');
    });
    root.append(button);
  }
}

customElements.define('shadow-widget', ShadowWidget);
