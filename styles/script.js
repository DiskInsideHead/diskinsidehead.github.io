
document.addEventListener('DOMContentLoaded', () => {
    let delay = 0.28;
    const blocks = document.querySelectorAll('.animated-block');
    blocks.forEach((block, index) => {
        block.style.animationDelay = `${delay}s`;
        delay += 0.28;
    });
});

document.addEventListener('DOMContentLoaded', function() {
   
    const config = {
        buttonColor: 'primary',
        buttonSize: '50px',    
        positionLeft: '20px',  
        positionBottom: '20px',
        icon: 'fi-home',       
        tooltip: 'Home Page'
    };
    
    const homeButton = document.createElement('a');
    homeButton.href = '/';
    homeButton.className = `btn btn-${config.buttonColor} position-fixed d-flex align-items-center justify-content-center`;
    homeButton.innerHTML = `<i class="${config.icon}"></i>`;
    homeButton.setAttribute('aria-label', config.tooltip);
    homeButton.setAttribute('data-bs-toggle', 'tooltip');
    homeButton.setAttribute('data-bs-placement', 'right');
    homeButton.title = config.tooltip;
    
    Object.assign(homeButton.style, {
        left: config.positionLeft,
        bottom: config.positionBottom,
        width: config.buttonSize,
        height: config.buttonSize,
        borderRadius: '50%',
        zIndex: '1000',
        boxShadow: '0 4px 8px rgba(0,0,0,0.2)',
        transition: 'all 0.3s ease'
    });

    homeButton.addEventListener('mouseenter', function() {
        this.style.transform = 'scale(1.1)';
        this.style.boxShadow = '0 6px 12px rgba(0,0,0,0.3)';
    });
    
    homeButton.addEventListener('mouseleave', function() {
        this.style.transform = 'scale(1)';
        this.style.boxShadow = '0 4px 8px rgba(0,0,0,0.2)';
    });
    
    document.body.appendChild(homeButton);
   
    if (typeof bootstrap !== 'undefined') {
        new bootstrap.Tooltip(homeButton);
    }
});
