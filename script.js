$(document).ready(function() {
    // Обработчики событий перетаскивания
    const CHUNK_SIZE = 1024 * 1024; // Размер куска 1МБ, к примеру
    const output = document.getElementById('output');
    const output2 = document.getElementById('output2');
    const clear_button = document.getElementById('clear_button');
    let dragTimeout; // Временная переменная для таймера
    $(window).on('dragover', function(e) {
        e.preventDefault();
        clearTimeout(dragTimeout); // Очистим предыдущий таймер, если он был установлен
        $('#dropModal').modal('show');
    });
    $(window).on('dragleave', function(e) {
        e.preventDefault();
        // Установим задержку перед тем, как закрыть модальное окно
        dragTimeout = setTimeout(function() {
            $('#dropModal').modal('hide'); // Скрыть модальное окно после задержки
        }, 100); // Например, задержка в 100 миллисекунд
    });
    $(window).on('drop', function(e) {
        e.preventDefault();
        clearTimeout(dragTimeout); // Очистим таймер, предотвращая закрытие модального окна
        $('#dropModal').modal('hide');
        let files = e.originalEvent.dataTransfer.files;
        handleFiles(files); // Место для функции handleFiles
    });

    function handleFiles(files) {
        Array.from(files).forEach(handleFile); // Для каждого файла вызвать handleFile
    }
    // Логика обработки файлов здесь
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
                            // Используем регулярное выражение для поиска подстрок в кавычках
                            let match = line.match(/"([^"]+)"/);
                            // Если находим совпадение и оно не содержит "ValveBiped", то добавляем текст без кавычек
                            if (match && !match[1].includes("ValveBiped")) {
                                modelTemplate += `${match[1]}\n`; // Используем match[1] для получения текста без кавычек
                            }
                        });
                        output2.textContent = modelTemplate;
                    }
                }
            });
            reader.readAsText(slice, "UTF-8");
        }
        processChunk(0);

        output.onclick = function() {
            this.select();
            document.execCommand("copy");
        };
    }
});

document.getElementById('clear_button').addEventListener('click', function() {
    // Получаем элемент <textarea> по его ID
    const output2 = document.getElementById('output2');
    let resultText = output2.value;
    let lines = resultText.split('\n');
    if (lines.length > 1) {
        let modelTemplate = "";
        lines.forEach((line) => {
            // Используем регулярное выражение для поиска подстрок в кавычках
            let match = line.match(/"([^"]+)"/);
            // Если находим совпадение и оно не содержит "ValveBiped"
            if (match && !match[1].includes("ValveBiped")) {
                modelTemplate += `${match[1]}\n`; // Используем match[1] для получения текста без кавычек
            }
        });
        // Обновляем свойство value элемента <textarea>
        output2.value = modelTemplate;
    }
});


document.getElementById('submit').addEventListener('click', function(e) {
    e.preventDefault(); // Предотвращаем стандартное поведение формы при отправке
    
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
        if (trimmedLine) { // Проверяем, не пустая ли строка после удаления пробелов
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

    // Проверяем, не пустой ли итоговый шаблон
    if (modelTemplate.trim()) {
        output2.value = modelTemplate;
    } else {
        alert("Пожалуйста, введите по крайней мере одну линию текста."); // Или другое действие по вашему желанию
    }
});

// Дождаться загрузки DOM
document.addEventListener('DOMContentLoaded', function() {
    // Находим элементы на странице
    const formHeight = document.querySelector('.col-sm form').offsetHeight; // Высота формы во второй колонке
    const textarea = document.getElementById('output2'); // Текстовое поле в первой колонке
    const clearButton = document.getElementById('clear_button'); // Кнопка в первой колонке

    // Вычисляем и устанавливаем новую высоту для текстового поля и кнопки
    const buttonHeight = clearButton.offsetHeight; // Высота кнопки
    const newTextAreaHeight = formHeight; // Вычитаем высоту кнопки и предполагаемого отступа (например, 24px сверху и снизу)

    // Применяем новую высоту к текстовому полю
    textarea.style.height = `${newTextAreaHeight}px`;
});