document.addEventListener('DOMContentLoaded', () => {
    const dmxInput = document.getElementById('dmx-input');
    const qcOutput = document.getElementById('qc-output');
    const convertBtn = document.getElementById('convert-btn');
    const copyBtn = document.getElementById('copy-btn');
    const clearBtn = document.getElementById('clear-btn');
    
    convertBtn.addEventListener('click', () => {
        const dmxData = dmxInput.value;
        const qcCode = parseDmxToQc(dmxData);
        qcOutput.value = qcCode;
    });
    
    copyBtn.addEventListener('click', () => {
        if (qcOutput.value) {
            qcOutput.select();
            document.execCommand('copy');
            showNotification('QC code copied to clipboard!', 'success');
        } else {
            showNotification('Nothing to copy! Generate QC code first.', 'warning');
        }
    });

    let notificationCount = 0;
    const MAX_NOTIFICATIONS = 5;
    const NOTIFICATION_SPACING = 80;
    const notificationQueue = [];

    function showNotification(message, type = 'info') {

        if (notificationCount >= MAX_NOTIFICATIONS && notificationQueue.length > 0) {
            const oldestNotification = notificationQueue.shift();
            if (oldestNotification && oldestNotification.parentNode) {
                oldestNotification.parentNode.removeChild(oldestNotification);
                notificationCount--;
                updateNotificationPositions();
            }
        }
        

        const notification = document.createElement('div');
        notification.className = `custom-notification custom-notification-${type}`;
        notification.style.bottom = `${20 + (notificationCount * NOTIFICATION_SPACING)}px`;
        notification.innerHTML = `
            <div class="notification-content">
                <span class="notification-message">${message}</span>
                <button class="notification-close">&times;</button>
            </div>
        `;
        

        document.body.appendChild(notification);
        notificationQueue.push(notification);
        notificationCount++;
        

        setTimeout(() => {
            notification.classList.add('show');
        }, 10);
        

        const closeBtn = notification.querySelector('.notification-close');
        closeBtn.addEventListener('click', () => {
            closeNotification(notification);
        });
        

        const autoCloseTimer = setTimeout(() => {
            closeNotification(notification);
        }, 4000);
        

        notification.autoCloseTimer = autoCloseTimer;
        

        notification.addEventListener('mouseenter', () => {
            clearTimeout(notification.autoCloseTimer);
            notification.style.opacity = '0.95';
        });
        

        notification.addEventListener('mouseleave', () => {
            notification.style.opacity = '1';
            notification.autoCloseTimer = setTimeout(() => {
                closeNotification(notification);
            }, 2000);
        });
    }

    function closeNotification(notification) {
        if (!notification || !notification.parentNode) return;
        
        notification.classList.remove('show');
        
        setTimeout(() => {
            if (notification.parentNode) {
        
                const index = notificationQueue.indexOf(notification);
                if (index > -1) {
                    notificationQueue.splice(index, 1);
                }
                
                notification.parentNode.removeChild(notification);
                notificationCount--;
                
        
                updateNotificationPositions();
            }
        }, 300);
    }

    function updateNotificationPositions() {
        notificationQueue.forEach((notification, index) => {
            notification.style.bottom = `${20 + (index * NOTIFICATION_SPACING)}px`;
            notification.style.zIndex = 10000 + index;
        });
    }

    clearBtn.addEventListener('click', () => {
        dmxInput.value = '';
        qcOutput.value = '';
    });
    
    const groupMapping = {
        "eyebrows": "eyebrow",
        "brow": "eyebrow",
        "brows": "eyebrow",
        "eyebrow": "eyebrow",
        "eyes": "eye",
        "eye": "eye",
        "eyelids": "eyelid",
        "eyelid": "eyelid",
        "lips": "mouth",
        "lip": "mouth",
        "mouth": "mouth",
        "noses": "nose",
        "nose": "nose",
        "cheeks": "cheek",
        "cheek": "cheek",
    };

    function getGroupName(fullName) {
        const parts = fullName.split(/[|\s]+/).map(part => part.toLowerCase().trim());

        for (const part of parts) {
            if (groupMapping[part]) {
                return groupMapping[part];
            }
        }

        return "Others";
    }
                        
    function getRestName(fullName) {
        const parts = fullName.split('|').map(part => part.trim());

        const filteredParts = parts.filter(part => {
            const lowerPart = part.toLowerCase();
            return !groupMapping[lowerPart] && !Object.values(groupMapping).includes(lowerPart);
        });

        return filteredParts.join(' ').trim() || "";
    }   
    
    function parseDmxToQc(dmxData) {

        const controllerRegex = /"DmeCombinationInputControl"\s*{[^}]*?"name"\s*"string"\s*"([^"]+)"/g;
        const controllers = [];
        let match;
        
        while ((match = controllerRegex.exec(dmxData)) !== null) {
            controllers.push(match[1]);
        }
        

        const groups = {};
        
        controllers.forEach(controller => {
            const group = getGroupName(controller);
            const rest = getRestName(controller);
            
            if (!groups[group]) {
                groups[group] = [];
            }
            
            groups[group].push({
                fullName: controller,
                rest: rest
            });
        });
        

        let qcCode = `$model "[FACE]" "head.dmx" {\n`;
        qcCode += `\tNoAutoDMXRules\n\n`;
        

        Object.keys(groups).sort().forEach(group => {
            groups[group].forEach(controller => {
                qcCode += `\tflexcontroller ${group} range 0 1 "${controller.rest}"\n`;
            });
            qcCode += `\n`;
        });
        

        controllers.forEach(controller => {
            const group = getGroupName(controller);
            const rest = getRestName(controller);
            const varName = rest.replace(/ /g, '|');
            qcCode += `\t%${controller} = "${rest}"\n`;
        });
        
        qcCode += `}`;
        
        return qcCode;
    }
});