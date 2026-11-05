// AI Panel - Cursor Agents Content Script (cursor.com/agents)

(function() {
  'use strict';

  const AI_TYPE = 'cursor';
  const LOAD_FLAG = '__AIPanelContentLoaded_cursor';
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
      '[data-testid*="composer" i] [contenteditable="true"]',
      '[class*="composer" i] [contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'div.ProseMirror[contenteditable="true"]',
      'div[contenteditable="true"]',
      'textarea[placeholder*="Ask" i]',
      'textarea[placeholder*="Message" i]',
      'textarea[aria-label*="Message" i]',
      'textarea'
    ];

    const inputEl = window.AIPanelDom?.findInputField(inputSelectors, { preferBottom: true });
    if (!inputEl) {
      throw new Error('Could not find Cursor Agents input field. Open an agent chat at cursor.com/agents.');
    }

    await window.AIPanelDom.setEditorText(inputEl, text, { afterInputDelay: 500 });
    const submitResult = await window.AIPanelDom.submitMessage(inputEl, {
      selectors: [
        'button[aria-label*="Send" i]',
        'button[data-testid*="send" i]',
        'button[type="submit"]',
        'button[aria-label*="Submit" i]',
        '[class*="composer" i] button'
      ],
      positivePattern: /(send|submit|发送|提交)/i,
      enterFallback: true,
      maxWait: 7000,
      submittingSelectors: [
        'button[aria-label*="Stop" i]',
        'button[aria-label*="Cancel" i]',
        '[class*="loading-indicator"]',
        '[class*="generating"]'
      ]
    });

    console.log('[AI Panel] Cursor message sent via', submitResult.method, 'starting response capture...');
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
      const mainContent =
        document.querySelector('[class*="composer-messages"]') ||
        document.querySelector('main') ||
        document.body;
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
      '[data-message-role="assistant"]',
      '[data-message-kind*="assistant" i]',
      '.markdown-root',
      '[class*="composer-message-markdown"]',
      '[class*="assistant"]',
      '.markdown'
    ];

    for (const selector of responseSelectors) {
      if (node.matches?.(selector) || node.querySelector?.(selector)) {
        console.log('[AI Panel] Cursor detected new response...');
        waitForStreamingComplete();
        break;
      }
    }
  }

  async function waitForStreamingComplete() {
    if (isCapturing) {
      console.log('[AI Panel] Cursor already capturing, skipping...');
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

        const isStreaming =
          document.querySelector('button[aria-label*="Stop" i]') ||
          document.querySelector('[class*="loading-indicator"]') ||
          document.querySelector('[class*="generating"]');

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
              console.log('[AI Panel] Cursor response captured, length:', currentContent.length);
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
    // Prefer role-tagged assistant messages (Cursor Agents / composer UIs)
    const roleNodes = document.querySelectorAll(
      '[data-message-role="assistant"], [data-message-kind*="assistant" i]'
    );
    if (roleNodes.length > 0) {
      const last = roleNodes[roleNodes.length - 1];
      const markdown = last.querySelector?.(
        '.markdown-root, [class*="composer-message-markdown"], .markdown, [class*="prose"]'
      );
      const text = (markdown || last).innerText?.trim();
      if (text) return text;
    }

    const markdownRoots = document.querySelectorAll(
      '.markdown-root, [class*="composer-message-markdown"], [class*="assistant-message"] .markdown'
    );
    if (markdownRoots.length > 0) {
      const last = markdownRoots[markdownRoots.length - 1];
      const text = last.innerText?.trim();
      if (text) return text;
    }

    // Fallback: last substantial prose block
    const blocks = document.querySelectorAll('[class*="message"] .markdown, [class*="prose"], .markdown');
    for (let i = blocks.length - 1; i >= 0; i--) {
      const text = blocks[i].innerText?.trim();
      if (text && text.length > 20) return text;
    }

    return null;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function injectFiles(filesData) {
    console.log('[AI Panel] Cursor injecting files:', filesData.length);

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

    throw new Error('Could not find Cursor file input or drop zone');
  }

  console.log('[AI Panel] Cursor Agents content script loaded');
})();
