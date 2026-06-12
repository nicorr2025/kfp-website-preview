/* Kentucky Forest Products — Interactive 3D Effects */

document.addEventListener('DOMContentLoaded', () => {
  // Subtle mouse-tilt for large glass cards (hero, contact form, etc.)
  // Skip nav dropdowns and small inline badges
  const cards = document.querySelectorAll('.glass-card');

  cards.forEach(el => {
    if (el.closest('nav')) return;
    if (el.classList.contains('inline-block')) return;

    el.style.willChange = 'transform';

    el.addEventListener('mousemove', (e) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 260) return;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = (e.clientX - cx) / (rect.width / 2) * 4;   // max ±4deg
      const dy = (e.clientY - cy) / (rect.height / 2) * 3;  // max ±3deg
      el.style.transition = 'transform 0.08s ease';
      el.style.transform = `perspective(1200px) rotateX(${-dy}deg) rotateY(${dx}deg) translateZ(6px)`;
    });

    el.addEventListener('mouseleave', () => {
      el.style.transition = 'transform 0.5s cubic-bezier(.22,.68,0,1.2)';
      el.style.transform = '';
    });
  });
});
