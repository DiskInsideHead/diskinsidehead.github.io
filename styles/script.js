
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

const musicHTML = `
<div class="d-flex justify-content-center d-none" id="volume-control-container" style="position: fixed; top: 10px; left: 0; right: 0; z-index: 1000;">
    <input class="form-range" id="volume-control" max="0.3" min="0" step="0.001" style="width: 400px;" type="range" value="0.1"/>
</div>
<audio id="background-music" loop src="https://storage6.lightaudio.ru/dm/399224fb/2044acaa/ATLUS%20—%20Aria%20of%20the%20Soul.mp3?d=337&v=a9a13d7712"></audio>
`;

document.body.insertAdjacentHTML('afterbegin', musicHTML);

const volumeControl = document.getElementById('volume-control');
const backgroundMusic = document.getElementById('background-music');

volumeControl.addEventListener('input', function() {
    backgroundMusic.volume = this.value;
});

backgroundMusic.volume = volumeControl.value;

document.addEventListener('DOMContentLoaded', () => {
    let clickCount = 0;
    const magicElement = document.getElementById('drop-area');
    const maxSnowflakes = 78;
    let snowflakes = [];
    const imageSources = [
        '/sourcetools/aigis.png',
        '/sourcetools/toast.png'
    ];


    const volumeControl = document.getElementById('volume-control');
    const backgroundMusic = document.getElementById('background-music');
    backgroundMusic.volume = volumeControl.value;
    volumeControl.addEventListener('input', function() {
        backgroundMusic.volume = this.value;
    });

    function applyBlueTheme() {
        const volumeContainer = document.getElementById('volume-control-container');
        volumeContainer.classList.remove('d-none');
        document.body.classList.add('blue-theme-body');
        document.querySelectorAll('h1, h2, h3').forEach(element => {
            element.classList.add('blue-theme-text');
        });
        let music = document.getElementById('background-music');
        music.volume = 0.1;
        music.play();
    }

    function resetTheme() {
        document.body.classList.remove('blue-theme-body');
        let music = document.getElementById('background-music');
        music.pause();
        music.currentTime = 0;
    }

    function createSnowflake() {
        if (snowflakes.length > maxSnowflakes) {
            return;
        }
        const size = Math.floor(Math.random() * (80 - 30 + 1) + 30);
        const snowflake = new Image(size, size);
        snowflake.src = imageSources[Math.floor(Math.random() * imageSources.length)];
        snowflake.classList.add('aigis');
        snowflake.style.left = `${Math.random() * (window.innerWidth - 75)}px`;
        const fallDuration = `${Math.random() * 5 + 5}s`;
        const sideDuration = `${Math.random() * 5 + 5}s`;
        snowflake.style.setProperty('--fall-duration', fallDuration);
        snowflake.style.setProperty('--side-duration', sideDuration);
        document.body.appendChild(snowflake);
        snowflakes.push(snowflake);
        setTimeout(() => {
            snowflake.style.opacity = 1;
        }, 10);
        snowflake.addEventListener('animationend', () => {
            snowflake.parentElement.removeChild(snowflake);
            snowflakes = snowflakes.filter(flake => flake !== snowflake);
        });
    }
    magicElement.addEventListener('click', () => {
        clickCount++;
        if (clickCount === 20) {
            applyBlueTheme();
            setInterval(createSnowflake, 600);
        }
    });
});
