const steps = [...document.querySelectorAll('[data-step]')];
const replay = document.querySelector('.replay');
let timers = [];

function play() {
  timers.forEach(clearTimeout);
  steps.forEach((el) => el.classList.remove('show'));
  timers = steps.map((el, i) => setTimeout(() => el.classList.add('show'), 500 + i * 1400));
}

replay.addEventListener('click', play);
play();
