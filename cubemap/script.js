
document.addEventListener('DOMContentLoaded', () => {
    let delay = 0.28;
    const blocks = document.querySelectorAll('.animated-block');
    blocks.forEach((block, index) => {
        block.style.animationDelay = `${delay}s`;
        delay += 0.28;
    });
});