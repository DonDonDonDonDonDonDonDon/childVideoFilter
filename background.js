/**
 * Background Service Worker
 * 處理跨域請求（字幕下載）、後端上傳代理
 */

// ===== 字幕代理下載（解決 CORS） =====
/**
 * 代理下載字幕內容
 * @param {string} url 字幕下載網址
 * @returns {Promise<{success: boolean, text?: string, error?: string}>}
 */
async function fetchCaptionProxy(url) {
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'text/xml, application/xml, */*',
            },
            // 允許重導向
            redirect: 'follow',
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const text = await response.text();
        return { success: true, text };
    } catch (error) {
        console.error('[ChildVideoFilter] Background: 字幕代理下載失敗', error);
        return { success: false, error: error.message };
    }
}

// ===== 後端上傳代理（預留，解決 CORS 或附加憑證） =====
/**
 * 代理上傳至後端
 * @param {string} endpoint 後端端點
 * @param {Object} data 上傳資料
 * @param {Object} options { apiKey, headers }
 * @returns {Promise<{success: boolean, data?: any, error?: string}>}
 */
async function uploadToBackendProxy(endpoint, data, options = {}) {
    try {
        const headers = {
            'Content-Type': 'application/json',
            ...options.headers,
        };
        if (options.apiKey) {
            headers['Authorization'] = `Bearer ${options.apiKey}`;
        }

        const response = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(data),
        });

        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${result.message || response.statusText}`);
        }
        return { success: true, data: result };
    } catch (error) {
        console.error('[ChildVideoFilter] Background: 後端上傳失敗', error);
        return { success: false, error: error.message };
    }
}

// ===== Storyboard 圖片代理下載（回傳 Blob 陣列，供 AI 判斷）=====
/**
 * 批次下載 Storyboard 圖片
 * @param {string[]} urls Storyboard URL 陣列
 * @param {Object} options
 * @param {number} options.maxConcurrent - 最大並行下載數 (預設 4)
 * @param {number} options.timeoutMs - 單張下載逾時 (預設 10000ms)
 * @returns {Promise<{success: boolean, blobs?: Blob[], errors?: string[]}>}
 */
async function fetchStoryboardsProxy(urls, options = {}) {
    const { maxConcurrent = 4, timeoutMs = 10000 } = options;
    const results = [];
    const errors = [];

    // 帶 Referer Header 避開 403
    const fetchWithTimeout = async (url, index) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Referer': 'https://www.youtube.com/',
                    'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
                },
                signal: controller.signal,
                redirect: 'follow',
            });
            clearTimeout(timeoutId);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            return { index, blob, success: true };
        } catch (error) {
            clearTimeout(timeoutId);
            return { index, error: error.message, success: false };
        }
    };

    // 並行控制佇列
    const queue = urls.map((url, i) => ({ url, index: i }));
    const running = [];

    const processQueue = async () => {
        while (queue.length > 0) {
            const { url, index } = queue.shift();
            const promise = fetchWithTimeout(url, index).then(result => {
                running.splice(running.indexOf(promise), 1);
                if (result.success) {
                    results[result.index] = result.blob;
                } else {
                    errors[result.index] = result.error;
                }
                return result;
            });
            running.push(promise);
            if (running.length >= maxConcurrent) {
                await Promise.race(running);
            }
        }
        await Promise.all(running);
    };

    await processQueue();

    const successCount = results.filter(b => b).length;
    console.log(`[ChildVideoFilter] Background: Storyboard 下載完成 ${successCount}/${urls.length}`);

    return {
        success: successCount > 0,
        blobs: results,
        errors: errors.length > 0 ? errors : undefined,
    };
}

// ===== 訊息處理 =====
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {
        case 'fetchCaption':
            fetchCaptionProxy(request.url).then(sendResponse);
            return true; // 非同步回應

        case 'uploadToBackend':
            uploadToBackendProxy(request.endpoint, request.data, request.options).then(sendResponse);
            return true;

        case 'fetchStoryboards':
            fetchStoryboardsProxy(request.urls, request.options).then(sendResponse);
            return true;

        default:
            sendResponse({ success: false, error: 'Unknown action' });
    }
});

// Service Worker 安裝/更新日誌
chrome.runtime.onInstalled.addListener(details => {
    console.log('[ChildVideoFilter] Service Worker 安裝/更新:', details.reason);
});

console.log('[ChildVideoFilter] Background Service Worker 啟動');