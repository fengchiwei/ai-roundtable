// AI Panel - Grok Content Script (grok.com)

(function() {
  'use strict';

  const AI_TYPE = 'grok';
  const LOAD_FLAG = '__AIPanelContentLoaded_grok';
  const LOAD_VERSION = chrome.runtime?.getManifest?.().version || 'unknown';
  if (window[LOAD_FLAG] === LOAD_VERSION) return;
  window[LOAD_FLAG] = LOAD_VERSION;

  function isContextValid() {
    return chrome.runtime && chrome.runtime.id;
  }

  function safeSendMessage(message, callback) {
    if (!isContextValid()) {
      console.log('[AI Panel] Extension context invalidated, skipping message');
      return;
    }
    try {
      chrome.runtime.sendMessage(message, callback);
    } catch (e) {
      console.log('[AI Panel] Failed to send message:', e.message);
    }
  }

  safeSendMessage({ type: 'CONTENT_SCRIPT_READY', aiType: AI_TYPE });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'INJECT_MESSAGE') {
      injectMessage(message.message)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    if (message.type === 'INJECT_FILES') {
      injectFiles(message.files)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    if (message.type === 'GET_LATEST_RESPONSE') {
      sendResponse({ content: getLatestResponse() });
      return true;
    }
  });

  setupResponseObserver();

  async function injectMessage(text) {
    const inputSelectors = [
      'div[aria-label="Ask Grok anything"][contenteditable="true"]',
      'div.tiptap.ProseMirror[contenteditable="true"]',
      'div.ProseMirror[contenteditable="true"]',
      'textarea[data-testid="grok-compose-input"]',
      'textarea[data-testid*="composer" i]',
      'textarea[aria-label*="Grok" i]',
      'textarea[placeholder*="Ask" i]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'textarea'
    ];

    const inputEl = window.AIPanelDom?.findInputField(inputSelectors, { preferBottom: true });
    if (!inputEl) {
      throw new Error('Could not find Grok input field');
    }

    await window.AIPanelDom.setEditorText(inputEl, text, { afterInputDelay: 500 });
    const submitResult = await window.AIPanelDom.submitMessage(inputEl, {
      selectors: [
        'button[data-testid="chat-submit"]',
        'button[aria-label="Submit"]',
        'button[aria-label="Send message"]',
        'button[aria-label*="Send" i]',
        'button[data-testid*="send" i]',
        'button[data-testid*="submit" i]',
        'button[type="submit"]'
      ],
      positivePattern: /(send|submit|发送|提交)/i,
      enterFallback: true,
      maxWait: 7000,
      submittingSelectors: [
        'button[aria-label*="Stop" i]',
        'button[aria-label*="Stop response" i]'
      ]
    });

    console.log('[AI Panel] Grok message sent via', submitResult.method, 'starting response capture...');
    waitForStreamingComplete();
    return true;
  }

  function setupResponseObserver() {
    const observer = new MutationObserver((mutations) => {
      if (!isContextValid()) {
        observer.disconnect();
        return;
      }
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              checkForResponse(node);
            }
          }
        }
      }
    });

    const startObserving = () => {
      if (!isContextValid()) return;
      const mainContent = document.querySelector('main') || document.body;
      observer.observe(mainContent, {
        childList: true,
        subtree: true
      });
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startObserving);
    } else {
      startObserving();
    }
  }

  let lastCapturedContent = '';
  let isCapturing = false;

  function checkForResponse(node) {
    if (isCapturing) return;

    const responseSelectors = [
      '[data-message-author-role="assistant"]',
      '[data-testid*="assistant" i]',
      '[class*="message-bubble"]',
      '[class*="response"]',
      '.markdown',
      '[class*="prose"]'
    ];

    for (const selector of responseSelectors) {
      if (node.matches?.(selector) || node.querySelector?.(selector)) {
        console.log('[AI Panel] Grok detected new response...');
        waitForStreamingComplete();
        break;
      }
    }
  }

  async function waitForStreamingComplete() {
    if (isCapturing) {
      console.log('[AI Panel] Grok already capturing, skipping...');
      return;
    }
    isCapturing = true;

    let previousContent = '';
    let stableCount = 0;
    const maxWait = 600000;
    const checkInterval = 500;
    const stableThreshold = 4;
    const startTime = Date.now();

    try {
      while (Date.now() - startTime < maxWait) {
        if (!isContextValid()) {
          console.log('[AI Panel] Context invalidated, stopping capture');
          return;
        }

        await sleep(checkInterval);

        const isStreaming = document.querySelector('button[aria-label*="Stop" i]') ||
                           document.querySelector('[aria-label*="Stop response" i]');
        const currentContent = getLatestResponse() || '';

        if (!isStreaming && currentContent === previousContent && currentContent.length > 0) {
          stableCount++;
          if (stableCount >= stableThreshold) {
            if (currentContent !== lastCapturedContent) {
              lastCapturedContent = currentContent;
              safeSendMessage({
                type: 'RESPONSE_CAPTURED',
                aiType: AI_TYPE,
                content: currentContent
              });
              console.log('[AI Panel] Grok response captured, length:', currentContent.length);
            }
            return;
          }
        } else {
          stableCount = 0;
        }

        previousContent = currentContent;
      }
    } finally {
      isCapturing = false;
    }
  }

  function getLatestResponse() {
    const containerSelectors = [
      '[data-message-author-role="assistant"]',
      '[data-testid*="assistant-message" i]',
      '[data-testid*="message-assistant" i]',
      '[class*="assistant-message"]',
      '[class*="response-content"]'
    ];

    for (const selector of containerSelectors) {
      const nodes = document.querySelectorAll(selector);
      if (nodes.length > 0) {
        const last = nodes[nodes.length - 1];
        const markdown = last.querySelector?.('.markdown, [class*="markdown"], [class*="prose"]');
        const text = (markdown || last).innerText?.trim();
        if (text) return text;
      }
    }

    // Fallback: last large prose/markdown block above the composer
    const proseBlocks = document.querySelectorAll('.markdown, [class*="prose"], [class*="message-content"]');
    if (proseBlocks.length > 0) {
      for (let i = proseBlocks.length - 1; i >= 0; i--) {
        const text = proseBlocks[i].innerText?.trim();
        if (text && text.length > 20) return text;
      }
    }

    return null;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function injectFiles(filesData) {
    console.log('[AI Panel] Grok injecting files:', filesData.length);

    const files = filesData.map(fileData => {
      const byteCharacters = atob(fileData.base64);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: fileData.type });
      return new File([blob], fileData.name, { type: fileData.type });
    });

    const fileInput = document.querySelector('input[type="file"]');
    if (fileInput) {
      const dataTransfer = new DataTransfer();
      files.forEach(file => dataTransfer.items.add(file));
      fileInput.files = dataTransfer.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(500);
      return true;
    }

    const dropZone = document.querySelector('div[contenteditable="true"]') || document.querySelector('textarea');
    if (dropZone) {
      const dataTransfer = new DataTransfer();
      files.forEach(file => dataTransfer.items.add(file));
      for (const eventType of ['dragenter', 'dragover', 'drop']) {
        dropZone.dispatchEvent(new DragEvent(eventType, {
          bubbles: true,
          cancelable: true,
          dataTransfer
        }));
        await sleep(50);
      }
      await sleep(500);
      return true;
    }

    throw new Error('Could not find Grok file input or drop zone');
  }

  console.log('[AI Panel] Grok content script loaded');
})();
