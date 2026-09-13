chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const button = document.getElementById('myButton');
    const text = document.getElementById('myText');
    console.log(button);
    var type = 1;


    button.addEventListener('click', async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if(type==1){
            type=0;
            document.body.style.transform = 'rotate(180deg)';
            text.textContent = '已旋轉網頁';
        }else{
            type=1;
            document.body.style.transform = 'rotate(0deg)';
            text.textContent = '已恢復網頁';
        }
                
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['execute.js']
        });

        // 2. 注入成功後再發送訊息
        chrome.tabs.sendMessage(tab.id, { action: 'rotatePage' });
        });
    
});