/**
 * =================================================================================
 * 项目: zimage-2api (Cloudflare Worker 单文件·全功能修复版)
 * 版本: 2.1.1 (代号: Turbo Cockpit - Context Fix)
 * 作者: 首席AI执行官 (Principal AI Executive Officer)
 * 协议: 奇美拉协议 · 综合版 (Project Chimera: Synthesis Edition)
 * 日期: 2025-12-07
 * * [v2.1.1 修复日志]
 * 1. [关键修复] 解决了 handleChatCompletions 中 'ctx' 未定义的错误。
 * 2. [类型增强] 添加了 JSDoc 类型注解，消除 TypeScript 检查报错。
 * 3. [稳定性] 保持了 btoa/atob 的 Web 标准实现，确保无环境依赖问题。
 * =================================================================================
 */

// --- [第一部分: 核心配置 (Configuration-as-Code)] ---
const CONFIG = {
  PROJECT_NAME: "zimage-2api",
  PROJECT_VERSION: "2.1.1",
  
  // 安全配置 (API Key) - 建议在部署后修改
  API_MASTER_KEY: "1", 
  
  // 上游服务配置
  UPSTREAM_URL: "https://z-image.62tool.com/api.php",
  ORIGIN_URL: "https://z-image.62tool.com",
  REFERER_URL: "https://z-image.62tool.com/",
  
  // 模型列表
  MODELS: ["z-image-turbo", "dall-e-3"],
  DEFAULT_MODEL: "z-image-turbo",

  // 默认参数
  DEFAULT_STEPS: 8,
  DEFAULT_SIZE: "1024x1024",

  // 轮询配置 (服务端模式)
  POLLING_INTERVAL: 1500,
  POLLING_TIMEOUT: 60000,
  
  // 伪装指纹池
  USER_AGENTS: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
  ]
};

// --- [第二部分: Worker 入口] ---
export default {
  /**
   * @param {Request} request
   * @param {Object} env
   * @param {ExecutionContext} ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return handleCorsPreflight();

    // 路由分发
    if (url.pathname === '/') return handleUI(request, apiKey);
    if (url.pathname === '/v1/models') return handleModelsRequest();
    if (url.pathname === '/v1/images/generations') return handleImageGenerations(request, apiKey);
    
    // [修复点] 显式传递 ctx 给 handleChatCompletions
    if (url.pathname === '/v1/chat/completions') return handleChatCompletions(request, apiKey, ctx);
    
    // [WebUI 专用] 状态查询接口
    if (url.pathname === '/v1/query/status') return handleStatusQuery(request, apiKey);

    return createErrorResponse(`Path not found: ${url.pathname}`, 404, 'not_found');
  }
};

// --- [第三部分: 核心业务逻辑] ---

class IdentityForge {
  static generateHex(length) {
    const chars = '0123456789abcdef';
    let result = '';
    for (let i = 0; i < length; i++) result += chars[Math.floor(Math.random() * chars.length)];
    return result;
  }

  static getHeaders() {
    const ua = CONFIG.USER_AGENTS[Math.floor(Math.random() * CONFIG.USER_AGENTS.length)];
    // 动态生成 Session 和 百度统计 ID
    const sessionCookie = this.generateHex(32);
    const hmAccount = this.generateHex(16).toUpperCase();
    const timestamp = Math.floor(Date.now() / 1000);
    
    const cookie = `server_name_session=${sessionCookie}; Hm_lvt_2348c268e6bf5008b52f68ddd772f997=${timestamp}; Hm_lpvt_2348c268e6bf5008b52f68ddd772f997=${timestamp}; HMACCOUNT=${hmAccount}`;

    return {
      "Authority": "z-image.62tool.com",
      "Accept": "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Content-Type": "application/json",
      "Origin": CONFIG.ORIGIN_URL,
      "Referer": CONFIG.REFERER_URL,
      "User-Agent": ua,
      "Cookie": cookie
    };
  }

  static generateTaskId() {
    return `task_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
  }
}

/**
 * 提交生成任务
 * @returns {Promise<Object>} { taskId, headers, success }
 */
async function submitTask(prompt, params = {}) {
    const headers = IdentityForge.getHeaders();
    const taskId = IdentityForge.generateTaskId();
    
    const payload = {
        "action": "create",
        "task_id": taskId,
        "task_type": "text2img-z-image",
        "task_data": {
            "prompt": prompt,
            "size": params.size || CONFIG.DEFAULT_SIZE,
            "seed": params.seed || Math.floor(Math.random() * 1000000),
            "steps": params.steps || CONFIG.DEFAULT_STEPS,
            "randomized": params.seed ? false : true
        },
        "status": 0
    };

    const res = await fetch(CONFIG.UPSTREAM_URL, {
        method: "POST", headers: headers, body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error(`Create Failed: ${res.status}`);
    const data = await res.json();
    
    if (!data.success) throw new Error(`API Refused: ${data.message}`);
    
    return { taskId, headers }; // 返回 headers 是因为查询时需要保持 Session 一致
}

/**
 * 查询任务状态
 */
async function queryTask(taskId, headers) {
    const payload = { "action": "query", "task_ids": [taskId] };
    const res = await fetch(CONFIG.UPSTREAM_URL, {
        method: "POST", headers: headers, body: JSON.stringify(payload)
    });
    
    if (!res.ok) return { status: 'retry' };
    const data = await res.json();
    
    if (data.success && data.data?.tasks?.length > 0) {
        const task = data.data.tasks[0];
        // status: 0=queue, 1=running, 2=success, -1=fail
        if (task.status === 2 && task.res_data?.image_url) {
            return { status: 'success', url: task.res_data.image_url.replace(/\\\//g, '/') };
        }
        if (task.status === -1) return { status: 'failed', error: 'Generation failed' };
        return { status: 'processing', progress: task.status === 1 ? 50 : 10 }; 
    }
    return { status: 'retry' };
}

// --- [API Handlers] ---

async function handleImageGenerations(request, apiKey) {
    if (!verifyAuth(request, apiKey)) return createErrorResponse('Unauthorized', 401, 'unauthorized');
    
    try {
        const body = await request.json();
        const prompt = body.prompt;
        
        // 提取自定义参数
        const size = body.size || CONFIG.DEFAULT_SIZE;
        const steps = body.steps || body.n_steps || CONFIG.DEFAULT_STEPS;
        const seed = body.seed ? parseInt(body.seed) : null;
        const clientPoll = body.client_poll === true; // WebUI 专用标记

        // 1. 提交任务
        const { taskId, headers } = await submitTask(prompt, { size, steps, seed });

        // [Mode A] 客户端轮询 (WebUI)
        if (clientPoll) {
            const authContext = btoa(JSON.stringify(headers));
            return new Response(JSON.stringify({ 
                status: "submitted", 
                task_id: taskId,
                auth_context: authContext
            }), { headers: corsHeaders({'Content-Type': 'application/json'}) });
        }

        // [Mode B] 服务端轮询 (Standard API Client)
        const startTime = Date.now();
        while (Date.now() - startTime < CONFIG.POLLING_TIMEOUT) {
            await new Promise(r => setTimeout(r, CONFIG.POLLING_INTERVAL));
            const result = await queryTask(taskId, headers);
            
            if (result.status === 'success') {
                return new Response(JSON.stringify({
                    created: Math.floor(Date.now() / 1000),
                    data: [{ url: result.url }]
                }), { headers: corsHeaders({'Content-Type': 'application/json'}) });
            }
            if (result.status === 'failed') throw new Error(result.error);
        }
        throw new Error("Timeout");

    } catch (e) {
        return createErrorResponse(e.message, 500, 'internal_error');
    }
}

// WebUI 专用的状态查询接口
async function handleStatusQuery(request, apiKey) {
    try {
        const body = await request.json();
        const { task_id, auth_context } = body;
        
        if (!task_id || !auth_context) throw new Error("Missing params");
        
        // 还原 Session Headers
        const headers = JSON.parse(atob(auth_context));
        const result = await queryTask(task_id, headers);
        
        return new Response(JSON.stringify(result), { headers: corsHeaders({'Content-Type': 'application/json'}) });
    } catch (e) {
        return createErrorResponse(e.message, 400, 'query_error');
    }
}

/**
 * 完美适配 Cherry Studio / NextChat 的聊天接口
 * 通过流式响应返回 Markdown 图片
 * * @param {Request} request
 * @param {string} apiKey
 * @param {ExecutionContext} ctx  <-- [修复点] 接收 ctx 参数
 */
async function handleChatCompletions(request, apiKey, ctx) {
    if (!verifyAuth(request, apiKey)) return createErrorResponse('Unauthorized', 401, 'unauthorized');
    
    const requestId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    
    try {
        const body = await request.json();
        const lastMsg = body.messages?.[body.messages.length - 1];
        if (!lastMsg) throw new Error("No messages provided");
        
        const prompt = lastMsg.content;
        const model = body.model || CONFIG.DEFAULT_MODEL;
        const stream = body.stream !== false; // 默认为流式

        // 提交生成任务
        const { taskId, headers } = await submitTask(prompt, { size: "1024x1024" }); // Chat 模式默认 1024

        // 如果客户端不支持流式，退回等待模式
        if (!stream) {
            let imgUrl = "";
            const startTime = Date.now();
            while (Date.now() - startTime < 60000) {
                await new Promise(r => setTimeout(r, 2000));
                const res = await queryTask(taskId, headers);
                if (res.status === 'success') { imgUrl = res.url; break; }
                if (res.status === 'failed') throw new Error("Generation Failed");
            }
            if (!imgUrl) throw new Error("Timeout");

            const content = `![Generated Image](${imgUrl})\n\n**Prompt:** ${prompt}`;
            return new Response(JSON.stringify({
                id: requestId,
                object: "chat.completion",
                created: created,
                model: model,
                choices: [{ index: 0, message: { role: "assistant", content: content }, finish_reason: "stop" }]
            }), { headers: corsHeaders({'Content-Type': 'application/json'}) });
        }

        // 开启流式响应 (SSE) - 专为 Cherry Studio 优化
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        const sendChunk = async (content, finish_reason = null) => {
            const chunk = {
                id: requestId,
                object: "chat.completion.chunk",
                created: created,
                model: model,
                choices: [{ index: 0, delta: { content: content }, finish_reason: finish_reason }]
            };
            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        };

        // 在后台处理轮询，不阻塞主线程
        // [修复点] 这里需要 ctx.waitUntil，所以函数签名必须包含 ctx
        ctx.waitUntil((async () => {
            try {
                // 1. 发送初始状态
                await sendChunk("🎨 正在请求 Z-Image 引擎生成图片...\n\n> " + prompt + "\n\n");
                
                let imgUrl = "";
                const startTime = Date.now();
                let steps = 0;

                // 2. 轮询循环
                while (Date.now() - startTime < 60000) {
                    await new Promise(r => setTimeout(r, 1500));
                    const res = await queryTask(taskId, headers);
                    
                    if (res.status === 'success') { 
                        imgUrl = res.url; 
                        break; 
                    }
                    if (res.status === 'failed') throw new Error("Generation Failed");
                    
                    // 发送进度点，保持连接活跃
                    if (steps % 2 === 0) await sendChunk("·");
                    steps++;
                }

                if (!imgUrl) throw new Error("Timeout");

                // 3. 发送最终图片 Markdown
                await sendChunk(`\n\n![Generated Image](${imgUrl})`);
                
                // 4. 发送结束信号
                await sendChunk("", "stop");
                await writer.write(encoder.encode("data: [DONE]\n\n"));

            } catch (error) {
                await sendChunk(`\n\n❌ **错误**: ${error.message}`, "stop");
                await writer.write(encoder.encode("data: [DONE]\n\n"));
            } finally {
                await writer.close();
            }
        })());

        return new Response(readable, {
            headers: corsHeaders({
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            })
        });

    } catch (e) {
        return createErrorResponse(e.message, 500, 'error');
    }
}

// --- 辅助函数 ---
function verifyAuth(req, key) {
    if (key === "1") return true;
    const h = req.headers.get('Authorization');
    return h && h === `Bearer ${key}`;
}
function corsHeaders(h={}) {
    return { ...h, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*' };
}
function handleCorsPreflight() { return new Response(null, { status: 204, headers: corsHeaders() }); }
function createErrorResponse(msg, status, code) {
    return new Response(JSON.stringify({ error: { message: msg, code } }), { status, headers: corsHeaders({'Content-Type': 'application/json'}) });
}
function handleModelsRequest() {
    return new Response(JSON.stringify({ object: 'list', data: CONFIG.MODELS.map(id => ({ id, object: 'model', created: Date.now(), owned_by: 'zimage' })) }), { headers: corsHeaders({'Content-Type': 'application/json'}) });
}


// --- [第四部分: 开发者驾驶舱 UI] ---
function handleUI(request, apiKey) {
  const origin = new URL(request.url).origin;
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Z-Image Turbo 驾驶舱</title>
    <style>
        :root { --bg: #0f172a; --panel: #1e293b; --text: #f8fafc; --accent: #3b82f6; --border: #334155; --success: #22c55e; }
        * { box-sizing: border-box; }
        body { font-family: 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); margin: 0; min-height: 100vh; display: flex; }
        
        .sidebar { width: 340px; background: var(--panel); border-right: 1px solid var(--border); padding: 20px; display: flex; flex-direction: column; gap: 20px; overflow-y: auto; height: 100vh; flex-shrink: 0; }
        .main { flex: 1; padding: 30px; display: flex; flex-direction: column; align-items: center; overflow-y: auto; height: 100vh; }
        
        h1 { margin: 0; font-size: 20px; display: flex; align-items: center; gap: 10px; color: var(--accent); }
        .badge { font-size: 10px; background: rgba(59,130,246,0.2); color: var(--accent); padding: 2px 6px; border-radius: 4px; }
        
        .control-group { display: flex; flex-direction: column; gap: 8px; }
        label { font-size: 12px; color: #94a3b8; font-weight: 600; display: flex; justify-content: space-between; }
        
        input, textarea, select { background: #0f172a; border: 1px solid var(--border); color: white; padding: 10px; border-radius: 6px; width: 100%; font-family: inherit; font-size: 13px; }
        textarea { resize: vertical; min-height: 80px; }
        
        /* 尺寸选择器 */
        .size-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
        .size-opt { background: #0f172a; border: 1px solid var(--border); border-radius: 6px; padding: 8px; cursor: pointer; text-align: center; transition: 0.2s; }
        .size-opt:hover { border-color: var(--accent); }
        .size-opt.active { background: var(--accent); border-color: var(--accent); color: white; }
        .size-icon { height: 20px; width: 100%; margin-bottom: 4px; background: #334155; border-radius: 2px; }
        .size-text { font-size: 10px; display: block; }

        /* 进度条 */
        .progress-box { width: 100%; background: #334155; height: 6px; border-radius: 3px; overflow: hidden; margin-top: 10px; display: none; }
        .progress-bar { height: 100%; background: var(--accent); width: 0%; transition: width 0.3s ease; }
        .status-text { font-size: 12px; color: var(--accent); text-align: center; margin-top: 5px; height: 18px; }

        button { background: var(--accent); color: white; border: none; padding: 12px; border-radius: 6px; font-weight: bold; cursor: pointer; transition: 0.2s; width: 100%; }
        button:hover { opacity: 0.9; }
        button:disabled { background: #475569; cursor: not-allowed; }

        .preview-area { width: 100%; max-width: 800px; flex: 1; display: flex; align-items: center; justify-content: center; background: #020617; border: 1px dashed var(--border); border-radius: 12px; position: relative; min-height: 400px; }
        .preview-img { max-width: 100%; max-height: 100%; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border-radius: 4px; display: none; }
        .placeholder { color: #475569; text-align: center; }
        
        .code-box { font-family: monospace; font-size: 11px; background: #000; padding: 10px; border-radius: 4px; color: #333; margin-top: 20px; word-break: break-all; color: #64748b; }
    </style>
</head>
<body>

<div class="sidebar">
    <h1>Z-Image Turbo <span class="badge">v2.1</span></h1>
    
    <div class="control-group">
        <label>API Key</label>
        <input type="password" id="apiKey" value="${apiKey}" readonly onclick="this.type='text'">
    </div>

    <div class="control-group">
        <label>提示词 (Prompt)</label>
        <textarea id="prompt" placeholder="Describe your image... (e.g. A futuristic city, cyberpunk style, 8k)">A cute cat, 8k high quality</textarea>
    </div>

    <div class="control-group">
        <label>尺寸 (Size)</label>
        <div class="size-grid" id="sizeGrid">
            </div>
    </div>

    <div class="control-group">
        <label>步数 (Steps) <span id="stepsVal">8</span></label>
        <input type="range" id="steps" min="1" max="20" value="8" oninput="document.getElementById('stepsVal').innerText=this.value">
    </div>

    <div class="control-group">
        <label>随机种子 (Seed) <span style="font-weight:normal;cursor:pointer" onclick="randomSeed()">🎲</span></label>
        <input type="number" id="seed" placeholder="Empty for random">
    </div>

    <div style="margin-top:auto">
        <button id="genBtn" onclick="startGeneration()">🚀 开始生成</button>
        <div class="status-text" id="statusText"></div>
        <div class="progress-box" id="progressBox">
            <div class="progress-bar" id="progressBar"></div>
        </div>
    </div>
</div>

<div class="main">
    <div class="preview-area" id="previewArea">
        <div class="placeholder" id="placeholder">
            图像预览区域<br>Ready to generate
        </div>
        <img id="resultImg" class="preview-img" onclick="window.open(this.src)">
    </div>
    <div class="code-box">
        API Endpoint: ${origin}/v1/images/generations <br>
        Chat Endpoint: ${origin}/v1/chat/completions (Cherry Studio Support)
    </div>
</div>

<script>
    const SIZES = [
        { label: "1:1", val: "1024x1024", iconH: "20px" },
        { label: "9:7", val: "1152x896", iconH: "18px" },
        { label: "7:9", val: "896x1152", iconH: "24px" },
        { label: "4:3", val: "1152x864", iconH: "18px" },
        { label: "3:4", val: "864x1152", iconH: "24px" },
        { label: "3:2", val: "1216x832", iconH: "16px" },
        { label: "2:3", val: "832x1216", iconH: "26px" },
        { label: "16:9", val: "1344x768", iconH: "14px" },
        { label: "9:16", val: "768x1344", iconH: "28px" }
    ];

    let currentSize = "1024x1024";

    function initUI() {
        const grid = document.getElementById('sizeGrid');
        SIZES.forEach(s => {
            const div = document.createElement('div');
            div.className = \`size-opt \${s.val === currentSize ? 'active' : ''}\`;
            div.onclick = () => selectSize(s.val, div);
            div.innerHTML = \`<div class="size-icon" style="height:\${s.iconH};width:\${parseInt(s.iconH) > 20 ? '14px' : '20px'};margin:0 auto 4px auto"></div><span class="size-text">\${s.label}</span>\`;
            grid.appendChild(div);
        });
    }

    function selectSize(val, el) {
        currentSize = val;
        document.querySelectorAll('.size-opt').forEach(e => e.classList.remove('active'));
        el.classList.add('active');
    }

    function randomSeed() {
        document.getElementById('seed').value = Math.floor(Math.random() * 1000000);
    }

    async function startGeneration() {
        const prompt = document.getElementById('prompt').value.trim();
        if(!prompt) return alert('请输入提示词');

        const seed = document.getElementById('seed').value;
        const steps = document.getElementById('steps').value;
        const btn = document.getElementById('genBtn');
        const pBox = document.getElementById('progressBox');
        const pBar = document.getElementById('progressBar');
        const sText = document.getElementById('statusText');
        const img = document.getElementById('resultImg');
        const ph = document.getElementById('placeholder');

        // Reset UI
        btn.disabled = true;
        pBox.style.display = 'block';
        pBar.style.width = '5%';
        sText.innerText = '正在初始化...';
        img.style.display = 'none';
        ph.style.display = 'block';
        ph.innerText = "正在请求 GPU 资源...";

        try {
            // 1. 提交任务
            const res = await fetch('/v1/images/generations', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + document.getElementById('apiKey').value
                },
                body: JSON.stringify({
                    prompt,
                    size: currentSize,
                    steps: parseInt(steps),
                    seed: seed ? parseInt(seed) : null,
                    client_poll: true // 开启 WebUI 轮询模式
                })
            });

            if(!res.ok) throw new Error(await res.text());
            const initData = await res.json();
            
            if(initData.status !== 'submitted') throw new Error("任务提交失败");
            
            const taskId = initData.task_id;
            const authContext = initData.auth_context;
            
            // 2. 客户端轮询
            let progress = 10;
            const pollInterval = setInterval(async () => {
                try {
                    // 模拟进度条自然增长
                    if(progress < 90) progress += (Math.random() * 5);
                    pBar.style.width = progress + '%';
                    sText.innerText = \`生成中... \${Math.floor(progress)}%\`;

                    const qRes = await fetch('/v1/query/status', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ task_id: taskId, auth_context: authContext })
                    });
                    
                    const qData = await qRes.json();
                    
                    if(qData.status === 'success') {
                        clearInterval(pollInterval);
                        pBar.style.width = '100%';
                        sText.innerText = '✅ 生成完成';
                        ph.style.display = 'none';
                        img.src = qData.url;
                        img.style.display = 'block';
                        btn.disabled = false;
                    } else if(qData.status === 'failed') {
                        throw new Error(qData.error || 'Unknown Error');
                    }
                } catch(e) {
                    clearInterval(pollInterval);
                    sText.innerText = '❌ ' + e.message;
                    sText.style.color = '#ef4444';
                    btn.disabled = false;
                }
            }, 1500);

        } catch(e) {
            sText.innerText = '❌ 请求失败';
            ph.innerText = e.message;
            btn.disabled = false;
        }
    }

    initUI();
</script>
</body>
</html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
