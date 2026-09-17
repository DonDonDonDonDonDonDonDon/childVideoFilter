/**
 * YouTube 影片資訊提取器
 * 支援一般影片 (/watch) 與 Shorts (/shorts/)
 * 非同步架構：可擴充字幕、畫面等需網路請求的欄位
 */

// ===== 頁面類型偵測器 =====
/**
 * 判斷目前頁面類型
 * @returns {'watch' | 'shorts' | null} 頁面類型，非影片頁回傳 null
 */
function detectPageType() {
    if (location.hostname !== 'www.youtube.com') return null;
    if (location.pathname === '/watch') return 'watch';
    if (location.pathname.startsWith('/shorts/')) return 'shorts';
    return null;
}

// ===== 共用工具函式 =====
/**
 * 從 ytInitialData 解析 videoId
 * @returns {string|null} 影片 ID
 */
function extractVideoIdFromInitialData() {
    try {
        const ytInitialData = window.ytInitialData;
        if (!ytInitialData) return null;

        // watch 頁面結構
        const videoPrimaryInfo = ytInitialData?.contents?.twoColumnWatchNextResults?.results?.results?.contents?.[0]?.videoPrimaryInfoRenderer;
        if (videoPrimaryInfo?.videoActions?.menuRenderer?.topLevelButtons) {
            const button = videoPrimaryInfo.videoActions.menuRenderer.topLevelButtons.find(
                b => b?.buttonRenderer?.commandMetadata?.webCommandMetadata?.url?.includes('/watch?v=')
            );
            if (button) {
                const url = button.buttonRenderer.commandMetadata.webCommandMetadata.url;
                const match = url.match(/[?&]v=([^&]+)/);
                if (match) return match[1];
            }
        }

        // shorts 頁面結構
        const reelVideoRenderer = ytInitialData?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.richGridRenderer?.contents?.[0]?.richItemRenderer?.content?.reelVideoRenderer;
        if (reelVideoRenderer?.videoId) return reelVideoRenderer.videoId;

        return null;
    } catch {
        return null;
    }
}

/**
 * 從 meta 標籤取得 videoId（較穩定）
 * @returns {string|null}
 */
function extractVideoIdFromMeta() {
    const meta = document.querySelector('meta[itemprop="videoId"]');
    return meta?.getAttribute('content') || null;
}

/**
 * 取得 videoId（多來源嘗試，優先序：meta > ytInitialData > URL）
 * @returns {Promise<string|null>}
 */
async function getVideoId() {
    // 1. meta 標籤（最穩定、最早可用）
    const metaId = extractVideoIdFromMeta();
    console.debug('[ChildVideoFilter] meta videoId:', metaId);
    if (metaId) return metaId;

    // 2. ytInitialData 解析（需等待頁面載入）
    const initialDataId = extractVideoIdFromInitialData();
    console.debug('[ChildVideoFilter] initialData videoId:', initialDataId);
    if (initialDataId) return initialDataId;

    // 3. 直接從 URL 解析（永遠可用、不依賴頁面結構，作為最終兜底）
    const urlMatch = location.href.match(/(?:v=|shorts\/)([^&?/]+)/);
    const urlId = urlMatch?.[1] || null;
    console.debug('[ChildVideoFilter] URL videoId:', urlId);
    return urlId;
}

/**
 * 安全取得 DOM 元素文字內容
 * @param {string} selector CSS 選擇器
 * @returns {string} 文字內容，找不到回傳空字串
 */
function getTextContent(selector) {
    const el = document.querySelector(selector);
    return el?.textContent?.trim() || '';
}

/**
 * 延遲函式
 * @param {number} ms 毫秒
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ===== 基礎資訊提取器（同步、DOM 型） =====
/**
 * 一般影片頁面提取器
 */
const watchExtractor = {
    /**
     * @returns {Promise<Partial<VideoInfo>>}
     */
    async extract() {
        const videoId = await getVideoId();
        return {
            videoId,
            pageType: 'watch',
            title: getTextContent('h1.ytd-video-primary-info-renderer yt-formatted-string')
                || document.querySelector('meta[property="og:title"]')?.getAttribute('content')
                || document.title.replace(' - YouTube', '').trim(),
            author: getTextContent('#owner #text a, #owner-text a, ytd-channel-name a'),
            viewCount: getTextContent('#info #count, #info-contents #count'),
            duration: getTextContent('.ytp-time-duration, #movie_player .ytp-time-duration'),
        };
    }
};

/**
 * Shorts 頁面提取器
 */
const shortsExtractor = {
    /**
     * @returns {Promise<Partial<VideoInfo>>}
     */
    async extract() {
        const videoId = await getVideoId();
        return {
            videoId,
            pageType: 'shorts',
            title: getTextContent('h1.ytd-reel-video-renderer yt-formatted-string')
                || document.querySelector('meta[property="og:title"]')?.getAttribute('content')
                || document.title.replace(' - YouTube', '').trim(),
            author: getTextContent('#owner #text a, #owner-text a'),
            viewCount: getTextContent('#view-count, .view-count'),
            duration: '', // Shorts 通常無顯示長度
        };
    }
};

// ===== 字幕提取器（非同步、需網路請求） =====
/**
 * 可用字幕軌道介面
 * @typedef {Object} CaptionTrack
 * @property {string} languageCode - 語言代碼（如 zh-Hant, en）
 * @property {string} languageName - 語言名稱
 * @property {boolean} isTranslatable - 是否可翻譯
 * @property {string} baseUrl - 字幕下載網址
 */

/**
 * 從 ytInitialData 解析可用字幕軌道
 * @returns {CaptionTrack[]}
 */
function parseCaptionTracksFromInitialData() {
    try {
        const playerResponse = window.ytInitialData?.playerResponse 
            || window.ytcfg?.data?.PLAYER_RESPONSE;
        if (!playerResponse) return [];

        const captions = playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (!Array.isArray(captions)) return [];

        return captions.map(track => ({
            languageCode: track.languageCode,
            languageName: track.name?.simpleText || track.languageCode,
            isTranslatable: track.isTranslatable || false,
            baseUrl: track.baseUrl,
        }));
    } catch {
        return [];
    }
}

/**
 * 取得可用字幕語言清單
 * @returns {Promise<CaptionTrack[]>}
 */
async function getAvailableCaptions() {
    // 先從初始資料解析
    let tracks = parseCaptionTracksFromInitialData();
    if (tracks.length > 0) return tracks;

    // 兜底：等待 ytInitialData 載入後重試
    for (let i = 0; i < 10; i++) {
        await sleep(500);
        tracks = parseCaptionTracksFromInitialData();
        if (tracks.length > 0) return tracks;
    }
    return [];
}

/**
 * 下載並解析字幕內容
 * @param {string} captionUrl 字幕下載網址
 * @returns {Promise<CaptionLine[]>}
 */
async function fetchAndParseCaption(captionUrl) {
    try {
        // 透過 background script 代理以避開 CORS
        const response = await chrome.runtime.sendMessage({
            action: 'fetchCaption',
            url: captionUrl,
        });
        if (!response?.success) throw new Error(response?.error || 'Failed to fetch caption');

        // 解析 XML 格式字幕
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(response.text, 'text/xml');
        const textElements = xmlDoc.querySelectorAll('text');

        return Array.from(textElements).map(el => ({
            start: parseFloat(el.getAttribute('start') || '0'),
            dur: parseFloat(el.getAttribute('dur') || '0'),
            text: el.textContent?.replace(/<\/?[^>]+>/g, '').trim() || '',
        })).filter(line => line.text);
    } catch (error) {
        console.warn('[ChildVideoFilter] 字幕抓取失敗:', error.message);
        return [];
    }
}

/**
 * 字幕提取器
 * @param {string[]} preferredLangs - 偏好語言代碼陣列（如 ['zh-Hant', 'zh', 'en']）
 * @returns {Promise<VideoInfo['captions']>}
 */
async function extractCaptions(preferredLangs = ['zh-Hant', 'zh', 'en', 'ja', 'ko']) {
    const tracks = await getAvailableCaptions();
    if (tracks.length === 0) return { availableLanguages: [], selectedLanguage: null, lines: [] };

    // 依偏好順序選擇語言
    const selectedTrack = preferredLangs
        .map(lang => tracks.find(t => t.languageCode.startsWith(lang)))
        .find(t => t)
        || tracks[0]; // 兜底取第一個

    const lines = await fetchAndParseCaption(selectedTrack.baseUrl);

    return {
        availableLanguages: tracks.map(t => ({ code: t.languageCode, name: t.languageName })),
        selectedLanguage: selectedTrack.languageCode,
        lines,
    };
}

// ===== 畫面提取器（Storyboard/預覽圖） =====
/**
 * 產生加權採樣索引（均勻 + 首尾加權）
 * AI 判斷時：開頭結尾常含關鍵資訊（片頭、片尾、廣告），給予較高權重
 * @param {number} totalFrames - 影片總幀數（Storyboard 總張數）
 * @param {number} sampleCount - 需採樣張數
 * @returns {number[]} 採樣索引陣列（去重、排序）
 */
function generateWeightedSampleIndices(totalFrames, sampleCount) {
    if (sampleCount >= totalFrames) return Array.from({ length: totalFrames }, (_, i) => i);

    const indices = new Set();

    // 1. 首尾加權：各取 2 張（索引 0,1 和倒數 1,2）
    const headCount = Math.min(2, Math.ceil(sampleCount * 0.2));
    const tailCount = Math.min(2, Math.ceil(sampleCount * 0.2));
    for (let i = 0; i < headCount; i++) indices.add(i);
    for (let i = 0; i < tailCount; i++) indices.add(totalFrames - 1 - i);

    // 2. 中間均勻採樣剩餘名額
    const remaining = sampleCount - indices.size;
    if (remaining > 0) {
        const start = headCount;
        const end = totalFrames - tailCount - 1;
        const step = (end - start) / (remaining + 1);
        for (let i = 1; i <= remaining; i++) {
            const idx = Math.round(start + step * i);
            indices.add(Math.max(start, Math.min(end, idx)));
        }
    }

    return Array.from(indices).sort((a, b) => a - b);
}

/**
 * 產生 Storyboard 縮圖 URL 陣列
 * YouTube Storyboard 格式：https://i.ytimg.com/sb/{videoId}/storyboard3_L{L}/$N.jpg
 * L1=低解析度(~160x90), L2=中解析度(~320x180), L3=高解析度(~640x360)
 * @param {string} videoId
 * @param {number} count - 擷取張數
 * @param {number} level - 解析度等級 1-3 (預設 2，平衡品質與頻寬)
 * @param {number[]} indices - 指定採樣索引（若提供則覆蓋 count）
 * @returns {string[]}
 */
function generateStoryboardUrls(videoId, count = 10, level = 2, indices = null) {
    const levelStr = `L${Math.max(1, Math.min(3, level))}`;
    const urls = [];

    if (indices && indices.length > 0) {
        for (const i of indices) {
            urls.push(`https://i.ytimg.com/sb/${videoId}/storyboard3_${levelStr}/${i}.jpg`);
        }
    } else {
        for (let i = 0; i < count; i++) {
            urls.push(`https://i.ytimg.com/sb/${videoId}/storyboard3_${levelStr}/${i}.jpg`);
        }
    }
    return urls;
}

/**
 * 產生標準預覽圖 URL
 * @param {string} videoId
 * @returns {Object} 各解析度預覽圖
 */
function generateThumbnailUrls(videoId) {
    return {
        default: `https://img.youtube.com/vi/${videoId}/default.jpg`,
        hq: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
        mq: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
        sd: `https://img.youtube.com/vi/${videoId}/sddefault.jpg`,
        maxres: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    };
}

/**
 * 透過 Background Script 下載 Storyboard 圖片為 Blob
 * @param {string[]} urls
 * @returns {Promise<Blob[]>}
 */
async function fetchStoryboardsAsBlobs(urls) {
    try {
        const response = await chrome.runtime.sendMessage({
            action: 'fetchStoryboards',
            urls,
            options: { maxConcurrent: 4, timeoutMs: 10000 },
        });
        console.debug('[ChildVideoFilter] Background 回應:', response);
        if (!response?.success) {
            console.error('[ChildVideoFilter] Background 回應失敗:', response);
            throw new Error(response?.error || 'Fetch failed');
        }
        return response.blobs || [];
    } catch (error) {
        console.warn('[ChildVideoFilter] Storyboard Blob 下載失敗:', error.message);
        return [];
    }
}

/**
 * 畫面提取器
 * @param {string} videoId
 * @param {Object} options
 * @param {number} options.storyboardCount - Storyboard 總張數（用於計算採樣）
 * @param {number} options.sampleCount - 實際採樣張數（預設 12）
 * @param {number} options.level - 解析度等級 1-3 (預設 2)
 * @param {'urls'|'blob'} options.format - 回傳格式：'urls' 僅回傳 URL，'blob' 下載並回傳 Blob 陣列
 * @returns {Promise<VideoInfo['frames']>}
 */
async function extractFrames(videoId, options = {}) {
    const {
        storyboardCount = 50,   // YouTube 通常有 50-100 張 storyboard
        sampleCount = 12,       // 實際送 AI 判斷的張數
        level = 2,              // L2 中解析度
        format = 'urls',        // 'urls' | 'blob'
    } = options;

    // 計算加權採樣索引
    const indices = generateWeightedSampleIndices(storyboardCount, sampleCount);

    // 產生對應 URL
    const storyboardUrls = generateStoryboardUrls(videoId, sampleCount, level, indices);

    const thumbnails = generateThumbnailUrls(videoId);

    if (format === 'blob') {
        // 下載為 Blob 陣列（供 AI 判斷）
        const blobs = await fetchStoryboardsAsBlobs(storyboardUrls);
        return {
            thumbnails,
            storyboard: storyboardUrls,      // 保留 URL 供參考
            storyboardBlobs: blobs,          // Blob 陣列（與 storyboardUrls 一一對應）
            sampleIndices: indices,          // 採樣索引（對應原始 storyboard 位置）
        };
    }

    return {
        thumbnails,
        storyboard: storyboardUrls,
        sampleIndices: indices,
    };
}

// ===== 統一提取入口 =====
const extractors = {
    watch: watchExtractor,
    shorts: shortsExtractor,
};

/**
 * 完整影片資訊介面
 * @typedef {Object} VideoInfo
 * @property {string} videoId
 * @property {'watch'|'shorts'} pageType
 * @property {string} title
 * @property {string} author
 * @property {string} viewCount
 * @property {string} duration
 * @property {Object} captions - { availableLanguages, selectedLanguage, lines[] }
 * @property {Object} frames - { thumbnails, storyboard[] }
 */

/**
 * 擷取完整影片資訊
 * @param {Object} options
 * @param {string[]} options.captionLangs - 字幕偏好語言
 * @param {number} options.storyboardCount - Storyboard 張數
 * @returns {Promise<VideoInfo|null>}
 */
async function extractVideoInfo(options = {}) {
    const pageType = detectPageType();
    if (!pageType) {
        console.log('[ChildVideoFilter] 非支援的 YouTube 頁面類型');
        return null;
    }

    const extractor = extractors[pageType];
    const baseInfo = await extractor.extract();

    const videoId = baseInfo.videoId;
    if (!videoId) {
        console.warn('[ChildVideoFilter] 無法取得 videoId');
        return null;
    }

    // 平行擷取字幕與畫面（非阻塞）
    const [captions, frames] = await Promise.allSettled([
        extractCaptions(options.captionLangs),
        extractFrames(videoId, {
            storyboardCount: options.storyboardCount || 50,
            sampleCount: options.sampleCount || 12,
            level: options.level || 2,
            format: options.framesFormat || 'urls',
        }),
    ]);

    return {
        ...baseInfo,
        captions: captions.status === 'fulfilled' ? captions.value : { availableLanguages: [], selectedLanguage: null, lines: [], error: captions.reason?.message },
        frames: frames.status === 'fulfilled' ? frames.value : { thumbnails: {}, storyboard: [], error: frames.reason?.message },
    };
}

// ===== 後端上傳介面（預留） =====
/**
 * 上傳影片資訊至後端
 * @param {VideoInfo} videoInfo
 * @param {Object} config - { endpoint, apiKey, ... }
 * @returns {Promise<{success: boolean, data?: any, error?: string}>}
 */
async function uploadToBackend(videoInfo, config = {}) {
    console.log("上傳影片資訊至後端------------------------------");
    // TODO: 實作實際上傳邏輯
    // 建議格式：
    // const response = await fetch(config.endpoint, {
    //     method: 'POST',
    //     headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
    //     body: JSON.stringify({ videoInfo, timestamp: Date.now() }),
    // });
    // return response.json();

    console.log('[ChildVideoFilter] 預留介面：上傳至後端', { videoInfo, config });
    return { success: true, data: { message: 'Mock upload successful' } };
}

// ===== AI 內容判斷介面（預留，待整合實際模型）=====
/**
 * AI 判斷結果介面
 * @typedef {Object} AIAnalysisResult
 * @property {boolean} safe - 是否安全（適合兒少）
 * @property {string[]} categories - 偵測到的風險類別
 * @property {number} confidence - 信心度 0-1
 * @property {Object[]} frameResults - 各幀詳細結果
 */

/**
 * 使用 AI 模型分析影片畫面
 * @param {Blob[]} frameBlobs - 影片幀 Blob 陣列
 * @param {Object} options
 * @param {string} options.model - 模型識別碼（如 'gpt-4o', 'gemini-1.5-pro', 'custom'）
 * @param {string} options.endpoint - API 端點（自架模型用）
 * @param {string} options.apiKey - API 金鑰
 * @param {Object} options.prompt - 自定義提示詞
 * @returns {Promise<AIAnalysisResult>}
 */
async function analyzeWithAI(frameBlobs, options = {}) {
    // TODO: 整合實際 AI API
    // 範例整合方式：
    // 1. 將 Blob 轉 Base64
    // const base64Frames = await Promise.all(frameBlobs.map(blob => blobToBase64(blob)));
    // 2. 呼叫 API
    // const response = await fetch(options.endpoint || 'https://api.openai.com/v1/chat/completions', {
    //     method: 'POST',
    //     headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${options.apiKey}` },
    //     body: JSON.stringify({
    //         model: options.model || 'gpt-4o',
    //         messages: [{
    //             role: 'user',
    //             content: [
    //                 { type: 'text', text: options.prompt || '分析這些影片畫面是否包含不適合兒少的內容（暴力、成人、恐怖、賭博等），回傳 JSON 格式' },
    //                 ...base64Frames.map(b64 => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }))
    //             ]
    //         }]
    //     })
    // });
    // 3. 解析回應

    console.log('[ChildVideoFilter] AI 分析介面（Mock）', { frameCount: frameBlobs.length, options });

    // Mock 回傳
    return {
        safe: true,
        categories: [],
        confidence: 0.95,
        frameResults: frameBlobs.map((_, i) => ({ frameIndex: i, safe: true, categories: [] })),
    };
}

/**
 * Blob 轉 Base64 工具函式
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}
// ===== 主流程 =====
/**
 * 主執行函式：偵測頁面 -> 擷取資訊 -> 輸出 -> （可選）AI 分析/上傳幀圖片
 * @param {Object} options
 * @param {string[]} options.captionLangs - 字幕偏好語言
 * @param {number} options.storyboardCount - Storyboard 總張數
 * @param {number} options.sampleCount - 實際採樣張數
 * @param {number} options.level - 解析度等級 1-3
 * @param {'urls'|'blob'} options.framesFormat - 回傳格式
 * @param {boolean} options.uploadFrames - 是否自動上傳幀圖片至後端（需 framesFormat: 'blob'）
 * @param {string} options.backendUrl - 後端基礎網址
 * @param {boolean} options.analyzeWithAI - 是否進行 AI 判斷
 * @param {Object} options.aiOptions - AI 選項
 * @param {boolean} options.uploadToBackend - 是否上傳完整資訊至後端（舊介面）
 * @param {Object} options.backendConfig - 後端設定（舊介面）
 */
async function findInformation(options = {}) {
    const {
        captionLangs = ['zh-Hant', 'zh', 'en', 'ja', 'ko'],
        storyboardCount = 50,
        sampleCount = 12,
        level = 2,
        framesFormat = 'urls',
        uploadFrames = false,
        backendUrl = 'http://localhost:8000',
        analyzeWithAI = false,
        aiOptions = {},
        uploadToBackend = false,
        backendConfig = {},
    } = options;

    const videoInfo = await extractVideoInfo({
        captionLangs,
        storyboardCount,
        sampleCount,
        level,
        framesFormat,
    });
    if (!videoInfo) return;
    console.log('[ChildVideoFilter] 影片資訊:', videoInfo);

    // 可選：自動上傳幀圖片至後端（需 framesFormat: 'blob'）
    if (uploadFrames && framesFormat === 'blob' && videoInfo.frames?.storyboardBlobs?.length > 0) {
        try {
            const uploadResult = await uploadFramesToBackend(
                videoInfo.videoId,
                videoInfo.frames.storyboardBlobs,
                backendUrl
            );
            console.log('[ChildVideoFilter] 幀圖片上傳結果:', uploadResult);
            videoInfo.frames.uploadResult = uploadResult;
        } catch (e) {
            console.error('[ChildVideoFilter] 幀圖片上傳失敗:', e);
        }
    }

    // 可選：AI 內容判斷（需 framesFormat: 'blob'）
    if (analyzeWithAI && videoInfo.frames?.storyboardBlobs?.length > 0) {
        const aiResult = await analyzeWithAI(videoInfo.frames.storyboardBlobs, aiOptions);
        console.log('[ChildVideoFilter] AI 判斷結果:', aiResult);
        videoInfo.aiAnalysis = aiResult;
    }

    // 可選：上傳完整資訊至後端（舊介面，預留）
    if (uploadToBackend) {
        const result = await uploadToBackend(videoInfo, backendConfig);
        console.log('[ChildVideoFilter] 上傳結果:', result);
    }
}

// ===== 初始化與事件監聽 =====
// 頁面載入執行（正確處理 async 函式的 Promise rejection）
// 預設啟用：抓取 blob 並自動上傳幀圖片至後端
findInformation({ 
    captionLangs: ['zh-Hant', 'zh', 'en'],
    framesFormat: 'blob',
    uploadFrames: true,
    sampleCount: 8,  // 預設少一點加快速度
})
    .catch(e => console.error('[ChildVideoFilter] Init error:', e));

// YouTube SPA 導航監聽
document.addEventListener('yt-navigate-finish', () => {
    findInformation({ 
        captionLangs: ['zh-Hant', 'zh', 'en'],
        framesFormat: 'blob',
        uploadFrames: true,
        sampleCount: 8,
    })
        .catch(e => console.error('[ChildVideoFilter] Navigation handler error:', e));
});

// 匯出供測試或擴充使用
window.ChildVideoFilter = {
    extractVideoInfo,
    extractCaptions,
    extractFrames,
    analyzeWithAI,
    blobToBase64,
    uploadToBackend,
    uploadFramesToBackend,
    detectPageType,
    getVideoId,
};

/**
 * 上傳幀圖片至後端
 * @param {string} videoId - 影片 ID
 * @param {Blob[]} frameBlobs - 幀 Blob 陣列
 * @param {string} backendUrl - 後端基礎網址
 * @returns {Promise<Object>} 上傳結果
 */
async function uploadFramesToBackend(videoId, frameBlobs, backendUrl = 'http://localhost:8000') {
    const formData = new FormData();
    formData.append('video_id', videoId);
    
    frameBlobs.forEach((blob, i) => {
        formData.append('frames', blob, `frame_${i}.jpg`);
    });
    
    const response = await fetch(`${backendUrl}/api/upload-frames`, {
        method: 'POST',
        body: formData,
    });
    
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    return response.json();
}