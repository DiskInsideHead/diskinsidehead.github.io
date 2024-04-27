$(document).ready(function() {
    
    const CHUNK_SIZE = 1024 * 1024; 
    const output = document.getElementById('output');
    const output2 = document.getElementById('output2');
    const clear_button = document.getElementById('clear_button');
    let dragTimeout; 
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
        Array.from(files).forEach(handleFile); 
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
            // document.execCommand("copy");
        };
        output2.onclick = function() {
            this.select();
            // document.execCommand("copy");
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