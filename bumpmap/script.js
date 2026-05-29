
document.addEventListener('DOMContentLoaded', () => {
    // задержка появления первого блока
    let delay = 0.28;
    const blocks = document.querySelectorAll('.animated-block');
    blocks.forEach((block, index) => {
        block.style.animationDelay = `${delay}s`;
        delay += 0.28; // увеличиваем задержку на 0.5 секунды для каждого следующего блока
    });
});