function processFile() {
    const fileInput = document.getElementById('file-input');
    const file = fileInput.files[0];

    if (file) {
        const reader = new FileReader();

        reader.onload = function(e) {
            let content = e.target.result;
            let start = content.indexOf('end\nskeleton');
            let end = content.indexOf('end\nvertexanimation');

            if (start !== -1 && end !== -1) {
                end += 'end\nvertexanimation'.length;

                // Удаление части от 'end\nskeleton' до 'end\nvertexanimation'.
                content = content.slice(0, start) + content.slice(end);

                // Здесь можно добавить код для сохранения обработанного содержимого.
                // В браузере лучше всего создать новый Blob и сохранить его как новый файл.
                const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });

                const link = document.createElement('a');
                link.href = URL.createObjectURL(blob);
                link.download = 'обработанный_' + file.name;
                link.click();
            } else {
                alert('Не могу найти нужные тебе кусочки, милый. Проверь, правильный ли файл ты дал мне? 😿');
            }
        };

        reader.readAsText(file);
    }
}