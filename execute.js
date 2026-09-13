// 監聽來自 popup 的訊息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {
        case 'rotatePage':
            document.body.style.transform = 'rotate(180deg)';
            break;
    }
});

function rotatePage() {
    document.body.style.transform = 'rotate(180deg)';
}