document.documentElement.classList.add('js');

const steps = [...document.querySelectorAll('[data-step]')];
const chat = document.querySelector('#demo');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let timers = [];

function play() {
  timers.forEach(clearTimeout);
  steps.forEach((el) => el.classList.remove('show'));
  if (reduceMotion) {
    steps.forEach((el) => el.classList.add('show'));
    return;
  }
  timers = steps.map((el, i) => setTimeout(() => el.classList.add('show'), 400 + i * 1400));
}

document.querySelector('.replay')?.addEventListener('click', play);
document.querySelector('[data-play]')?.addEventListener('click', play);

new IntersectionObserver((entries, observer) => {
  if (entries.some((e) => e.isIntersecting)) {
    observer.disconnect();
    play();
  }
}, { threshold: 0.5 }).observe(chat);
