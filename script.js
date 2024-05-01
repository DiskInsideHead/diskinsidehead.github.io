$(document).ready(function() {
    const CHUNK_SIZE = 1024 * 1024;
    const output = document.getElementById('output');
    const output2 = document.getElementById('output2');
    const clear_button = document.getElementById('clear_button');
    let dragTimeout;
    $('#copy_bones_button').on('click', function() {
        output2.select();
        document.execCommand("copy");
        $(this).html('<i class="fi-check"></i>');
        setTimeout(function() {
            $('#copy_bones_button').html('<i class="fi-clipboard"></i>');
        }, 2000);
        if (window.getSelection) {
            if (window.getSelection().empty) {
                window.getSelection().empty();
            } else if (window.getSelection().removeAllRanges) {
                window.getSelection().removeAllRanges();
            }
        } else if (document.selection) {
            document.selection.empty();
        }
    });
    $('#copy_flex_button').on('click', function() {
        output.select();
        document.execCommand("copy");
        $(this).html('<i class="fi-check"></i>');
        setTimeout(function() {
            $('#copy_flex_button').html('<i class="fi-clipboard"></i>');
        }, 2000);
        if (window.getSelection) {
            if (window.getSelection().empty) {
                window.getSelection().empty();
            } else if (window.getSelection().removeAllRanges) {
                window.getSelection().removeAllRanges();
            }
        } else if (document.selection) {
            document.selection.empty();
        }
    });
    $('#formFileLg').on('change', function(e) {
        const files = e.target.files;
        if (files.length === 1) {
            const file = files[0];
            if (file.name.toLowerCase().endsWith('.vta')) {
                handleFile(file);
            } else {
                alert('Please select a VTA file.');
            }
        } else {
            alert('Please select only one file.');
        }
    });
    $(window).on('dragover', function(e) {
        e.preventDefault();
        clearTimeout(dragTimeout);
        $('#dropModal').modal('show');
    });
    $(window).on('dragleave', function(e) {
        e.preventDefault();
        dragTimeout = setTimeout(function() {
            $('#dropModal').modal('hide');
        }, 100);
    });
    $(window).on('drop', function(e) {
        e.preventDefault();
        clearTimeout(dragTimeout);
        $('#dropModal').modal('hide');
        let files = e.originalEvent.dataTransfer.files;
        handleFiles(files);
    });

    function handleFiles(files) {
        Array.from(files).forEach(file => {
            if (file.name.toLowerCase().endsWith('.vta')) {
                handleFile(file);
            } else {
                alert('Please select a VTA file.');
            }
        });
    }

    function handleFile(file) {
        var filename = file.name.split('.')[0];

        function processChunk(start) {
            let end = start + CHUNK_SIZE;
            let slice = file.slice(start, end);
            let reader = new FileReader();
            reader.onload = (function(event) {
                let text = event.target.result;
                let startTextIndex = text.indexOf("skeleton");
                let endTextIndex = text.indexOf("vertexanimation");
                if (startTextIndex > -1 && endTextIndex > -1) {
                    let resultText = text.slice(startTextIndex, endTextIndex);
                    let lines = resultText.split('\n');
                    if (lines.length > 2) {
                        lines.splice(0, 2);
                        lines.pop();
                        lines.pop();
                        lines = lines.map(line => line.replace(/time \d+ # /, '').trim());
                        let modelTemplate = `$model "[FACE]" "${filename}.smd" {\nflexfile "${filename}.vta"\n{\ndefaultflex frame 0\n`;
                        lines.forEach((line, index) => {
                            modelTemplate += `flex H${index+1} frame ${index+1}\n`;
                        });
                        modelTemplate += `}\n`;
                        lines.forEach((line, index) => {
                            modelTemplate += `flexcontroller H${index+1} range 0 1 "${line.trim()}"\n`;
                        });
                        modelTemplate += `\n`;
                        lines.forEach((line, index) => {
                            modelTemplate += `%H${index+1} = "${line.trim()}"\n`;
                        });
                        modelTemplate += `}`;
                        output.textContent = modelTemplate;
                    }
                }
                let startTextIndex2 = text.indexOf("nodes");
                let endTextIndex2 = text.indexOf("skeleton");
                if (startTextIndex2 > -1 && endTextIndex2 > -1) {
                    let resultText = text.slice(startTextIndex2, endTextIndex2);
                    let lines = resultText.split('\n');
                    if (lines.length > 1) {
                        lines.splice(0, 1);
                        lines.pop();
                        lines.pop();
                        let modelTemplate = "";
                        lines.forEach((line) => {
                            let match = line.match(/"([^"]+)"/);
                            if (match && !match[1].includes("ValveBiped")) {
                                modelTemplate += `${match[1]}\n`;
                            }
                        });
                        output2.value = modelTemplate;
                    }
                }
            });
            reader.readAsText(slice, "UTF-8");
        }
        processChunk(0);
        output.onclick = function() {
            this.select();
        };
        output2.onclick = function() {
            this.select();
        };
    }
});
document.getElementById('clear_button').addEventListener('click', function() {
    const output2 = document.getElementById('output2');
    let resultText = output2.value;
    let lines = resultText.split('\n');
    if (lines.length > 1) {
        let modelTemplate = "";
        lines.forEach((line) => {
            let match = line.match(/"([^"]+)"/);
            if (match && !match[1].includes("ValveBiped")) {
                modelTemplate += `${match[1]}\n`;
            }
        });
        output2.value = modelTemplate;
    }
});
document.getElementById('submit').addEventListener('click', function(e) {
    e.preventDefault();
    const length = document.getElementById('length').value;
    const tip_mass = document.getElementById('tip_mass').value;
    const pitch_stiffness = document.getElementById('pitch_stiffness').value;
    const pitch_damping = document.getElementById('pitch_damping').value;
    const yaw_stiffness = document.getElementById('yaw_stiffness').value;
    const yaw_damping = document.getElementById('yaw_damping').value;
    const along_stiffness = document.getElementById('along_stiffness').value;
    const along_damping = document.getElementById('along_damping').value;
    const angle_constraint = document.getElementById('angle_constraint').value;
    const pitch_constraint_s = document.getElementById('pitch_constraint_s').checked;
    const pitch_constraint_min = document.getElementById('pitch_constraint_min').value;
    const pitch_constraint_max = document.getElementById('pitch_constraint_max').value;
    const yaw_constraint_s = document.getElementById('yaw_constraint_s').checked;
    const yaw_constraint_min = document.getElementById('yaw_constraint_min').value;
    const yaw_constraint_max = document.getElementById('yaw_constraint_max').value;
    const output2 = document.getElementById('output2');
    let resultText = output2.value;
    let lines = resultText.split('\n');
    let modelTemplate = "";
    lines.forEach((line) => {
        let trimmedLine = line.trim();
        if (trimmedLine) {
            modelTemplate += `$jigglebone "${trimmedLine}"\n{\nis_flexible\n{\n`;
            modelTemplate += `length ${length} tip_mass ${tip_mass} pitch_stiffness ${pitch_stiffness} pitch_damping ${pitch_damping}`;
            modelTemplate += ` yaw_stiffness ${yaw_stiffness} yaw_damping ${yaw_damping} along_stiffness ${along_stiffness}`;
            modelTemplate += ` along_damping ${along_damping} angle_constraint ${angle_constraint}\n`;
            if (pitch_constraint_s) {
                modelTemplate += `pitch_constraint ${pitch_constraint_min} ${pitch_constraint_max}\n`;
            }
            if (yaw_constraint_s) {
                modelTemplate += `yaw_constraint ${yaw_constraint_min} ${yaw_constraint_max}\n`;
            }
            modelTemplate += "}\n}\n";
        }
    });
    if (modelTemplate.trim()) {
        output2.value = modelTemplate;
    } else {
        alert("Пожалуйста, введите по крайней мере одну линию текста.");
    }
});
document.addEventListener('DOMContentLoaded', function() {
    const formHeight = document.querySelector('.col-sm form').offsetHeight;
    const textarea = document.getElementById('output2');
    const clearButton = document.getElementById('clear_button');
    const buttonHeight = clearButton.offsetHeight;
    const newTextAreaHeight = formHeight;
    textarea.style.height = `${newTextAreaHeight}px`;
});
document.addEventListener('DOMContentLoaded', () => {
    let clickCount = 0;
    const magicElement = document.getElementById('drop-area');
    const maxSnowflakes = 78;
    let snowflakes = [];
    const volumeControl = document.getElementById('volume-control');
    const backgroundMusic = document.getElementById('background-music');
    // Устанавливаем начальное значение громкости музыки
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
        music.volume = 0.1; // Установим громкость на 20%
        music.play();
    }
    // Функция для сброса темы страницы (если понадобится)
    function resetTheme() {
        document.body.classList.remove('blue-theme-body');

        // Останавливаем воспроизведение музыки
        let music = document.getElementById('background-music');
        music.pause();
        music.currentTime = 0; // Сброс к началу
    }

    function createSnowflake() {
        if (snowflakes.length > maxSnowflakes) {
            return;
        }
        const snowflake = new Image(75, 75);
        snowflake.src = 'aigis.png';
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