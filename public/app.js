// public/app.js — modal-login + keep session until leaving site + scrollable feed
(async function () {
  const USING_LIVE_SERVER = !!window.__USING_LIVE_SERVER;
  const SOCKET_URL = window.__SOCKET_URL || (USING_LIVE_SERVER ? 'http://localhost:3000' : window.location.origin);
  const API_BASE = USING_LIVE_SERVER ? 'http://localhost:3000' : window.location.origin;

  // wait for socket.io client if present
  function waitForIo(timeout = 3000) {
    return new Promise((resolve) => {
      if (typeof io !== 'undefined') return resolve(true);
      const start = Date.now();
      const iv = setInterval(() => {
        if (typeof io !== 'undefined') { clearInterval(iv); return resolve(true); }
        if (Date.now() - start > timeout) { clearInterval(iv); return resolve(false); }
      }, 50);
    });
  }

  const hasIo = await waitForIo();
  const socket = hasIo ? io(SOCKET_URL) : { on: ()=>{}, emit: ()=>{}, connected:false };

  // UI refs
  const loginModal = document.getElementById('loginModal');
  const passwordInput = document.getElementById('passwordInput');
  const registerBtn = document.getElementById('registerBtn');
  const loginBtn = document.getElementById('loginBtn');
  const authMsg = document.getElementById('authMsg');
  const ownerControls = document.getElementById('ownerControls');
  const logoutBtn = document.getElementById('logoutBtn');

  const feed = document.getElementById('feed');
  const onlineCountEl = document.getElementById('onlineCount');

  const compose = document.getElementById('compose');
  const itemName = document.getElementById('itemName');
  const postPrice = document.getElementById('postPrice');
  const moreBtn = document.getElementById('moreBtn');
  const postImage = document.getElementById('postImage');
  const postBtn = document.getElementById('postBtn');

  const extraFields = document.getElementById('extraFields');
  const postLocation = document.getElementById('postLocation');
  const postPhone = document.getElementById('postPhone');
  const postTitle = document.getElementById('postTitle');

  const previewArea = document.getElementById('previewArea');
  const previewImg = document.getElementById('previewImg');
  const removePreview = document.getElementById('removePreview');

  const notifAudio = document.getElementById('notifAudio');

  // state
  let userToken = localStorage.getItem('ac_token') || null;
  let userId = localStorage.getItem('ac_userId') || null;
  let notifPlaying = false;
  let notifStopTimer = null;
  let imageFile = null;

  // helpers
  function escapeHtml(s){ if(!s) return ''; return s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
  function absoluteImageUrl(imgPath){ if(!imgPath) return null; if(imgPath.startsWith('http://') || imgPath.startsWith('https://')) return imgPath; const base=API_BASE.replace(/\/$/,''); return base + (imgPath.startsWith('/') ? imgPath : '/' + imgPath); }

  function showModal(){ loginModal.classList.add('visible'); passwordInput.focus(); }
  function hideModal(){ loginModal.classList.remove('visible'); authMsg.textContent=''; }
  function showCompose(){ compose.classList.remove('hidden'); previewArea.classList.remove('hidden'); previewArea.classList.add('hidden'); } // ensure preview hidden initially
  function hideCompose(){ compose.classList.add('hidden'); }

  function setAuth(token, uid){
    userToken = token; userId = uid;
    localStorage.setItem('ac_token', token);
    localStorage.setItem('ac_userId', uid);
    authMsg.textContent = 'Owner logged in';
    ownerControls.classList.remove('hidden');
    hideModal();
    showCompose();
    requestNotificationAndUnlockAudio();
  }
  function clearAuth(){
    userToken = null; userId = null;
    localStorage.removeItem('ac_token'); localStorage.removeItem('ac_userId');
    passwordInput.value = '';
    ownerControls.classList.add('hidden');
    hideCompose();
    showModal();
  }

  // On initial load: feed visible to everyone, modal appears for login if not logged
  function initUI(){
    if (userToken && userId) {
      // quick verify? we assume token valid for now
      ownerControls.classList.remove('hidden');
      hideModal();
      showCompose();
    } else {
      ownerControls.classList.add('hidden');
      hideCompose();
      showModal();
    }
  }

  // load & render posts
  async function loadPosts(){
    try{
      const res = await fetch(`${API_BASE}/api/posts`);
      if (!res.ok) throw new Error('Failed to fetch posts: ' + res.status);
      const posts = await res.json();
      renderPosts(posts);
    } catch(e){
      console.error('Load posts failed', e);
    }
  }
  function renderPosts(posts){
    feed.innerHTML = '';
    posts.forEach(p=>{
      const imgUrl = absoluteImageUrl(p.image);
      const el = document.createElement('div');
      el.className = 'postItem';
      el.innerHTML = `
        <div class="postLeft">
          <div class="postTitle">${escapeHtml(p.itemName || '')}</div>
          ${imgUrl ? `<img src="${imgUrl}" alt="image" />` : ''}
          <div class="meta">${escapeHtml(p.location || '')} • ${escapeHtml(p.phone || '')}</div>
          ${p.description ? `<div class="meta small">${escapeHtml(p.description)}</div>` : ''}
        </div>
        <div class="postRight">
          <div class="meta">Ksh ${escapeHtml(p.price || '')}</div>
          ${String(p.ownerUserId) === String(userId) ? `<button class="iconBtn deleteBtn" data-id="${p.id}" title="Delete"><i class='bx bx-trash'></i></button>` : ''}
        </div>
      `;
      feed.appendChild(el);
    });

    // attach delete handlers after rendering
    document.querySelectorAll('.deleteBtn').forEach(btn=>{
      btn.addEventListener('click', async ()=> {
        const id = btn.getAttribute('data-id');
        if (!confirm('Delete this post?')) return;
        try {
          const res = await fetch(`${API_BASE}/api/posts/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${userToken}` } });
          const body = await res.json();
          if (!res.ok) throw new Error(body.error || 'Delete failed');
          loadPosts();
        } catch(err){ alert('Delete failed: ' + err.message); }
      });
    });
  }

  // Register & Login handlers
  registerBtn.addEventListener('click', async ()=>{
    const pw = passwordInput.value.trim();
    authMsg.textContent = '';
    if (pw.length < 4) { authMsg.textContent = 'Password must be at least 4 characters.'; return; }
    try {
      const res = await fetch(`${API_BASE}/api/register`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ password: pw }) });
      const body = await res.json();
      if (!res.ok) { authMsg.textContent = body.error || 'Register failed'; return; }
      setAuth(body.token, body.userId);
      await loadPosts();
    } catch(e){ authMsg.textContent = 'Error registering'; console.error(e); }
  });

  loginBtn.addEventListener('click', async ()=>{
    const pw = passwordInput.value.trim();
    authMsg.textContent = '';
    if (!pw) { authMsg.textContent = 'Enter password.'; return; }
    try {
      const res = await fetch(`${API_BASE}/api/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ password: pw }) });
      const body = await res.json();
      if (!res.ok) { authMsg.textContent = body.error || 'Login failed'; return; }
      setAuth(body.token, body.userId);
      await loadPosts();
    } catch(e){ authMsg.textContent = 'Error logging in'; console.error(e); }
  });

  logoutBtn.addEventListener('click', ()=> {
    clearAuth();
  });

  // Compose behavior
  moreBtn.addEventListener('click', ()=> {
    extraFields.classList.toggle('hidden');
    moreBtn.innerHTML = extraFields.classList.contains('hidden') ? "<i class='bx bx-chevron-up'></i>" : "<i class='bx bx-chevron-down'></i>";
  });

  postImage.addEventListener('change', (e)=> {
    const f = e.target.files && e.target.files[0];
    if (!f) return hidePreview();
    if (!f.type.startsWith('image/')) { alert('Only images allowed'); postImage.value=''; return; }
    imageFile = f;
    previewImg.src = URL.createObjectURL(f);
    previewArea.classList.remove('hidden');
  });
  removePreview.addEventListener('click', ()=> { postImage.value=''; imageFile=null; hidePreview(); });
  function hidePreview(){ previewArea.classList.add('hidden'); previewImg.src=''; }

  postBtn.addEventListener('click', async ()=>{
    if (!userToken) return alert('You must be logged in to post.');
    const name = itemName.value.trim(); if (!name) return alert('Enter item name.');
    const form = new FormData();
    form.append('itemName', name);
    if (postTitle.value.trim()) form.append('description', postTitle.value.trim());
    if (postLocation.value.trim()) form.append('location', postLocation.value.trim());
    if (postPhone.value.trim()) form.append('phone', postPhone.value.trim());
    if (postPrice.value.trim()) form.append('price', postPrice.value.trim());
    if (imageFile) form.append('image', imageFile);

    try {
      const res = await fetch(`${API_BASE}/api/posts`, { method:'POST', body: form, headers: { Authorization: `Bearer ${userToken}` } });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Post failed');
      // reset fields (do NOT clear auth)
      itemName.value=''; postTitle.value=''; postLocation.value=''; postPhone.value=''; postPrice.value=''; postImage.value=''; imageFile=null; hidePreview();
      // reload feed (socket will also update)
      await loadPosts();
      // keep focus on itemName for next post
      itemName.focus();
    } catch(e){ alert('Post failed: ' + e.message); console.error(e); }
  });

  // Socket handlers
  try {
    socket.on('connect', () => console.log('socket connected — id:', socket.id));
    socket.on('connect_error', (err) => console.error('Socket connect_error:', err));
    socket.on('new_post', (p) => {
      if (("Notification" in window) && Notification.permission === "granted") {
        const n = new Notification('New listing: ' + (p.itemName || ''), { body: `${p.location || ''} • Ksh ${p.price || ''}`, icon: absoluteImageUrl(p.image) || '/favicon.png' });
        setTimeout(()=> n.close(), 5000);
      }
      playNotificationAudioLoop(60_000); // play up to 60s
      loadPosts();
    });
    socket.on('deleted_post', ({id}) => loadPosts());
    socket.on('online_count', (n) => { onlineCountEl.textContent = n; });
  } catch(e) {
    console.warn('Socket not available', e);
  }

  // Notification & audio unlocking
  function requestNotificationAndUnlockAudio(){
    if ("Notification" in window && Notification.permission !== "granted") {
      Notification.requestPermission().then(() => {
        if (notifAudio) {
          notifAudio.play().then(()=>{ notifAudio.pause(); notifAudio.currentTime = 0; }).catch(()=>{});
        }
      });
    } else {
      if (notifAudio) { notifAudio.play().then(()=>{ notifAudio.pause(); notifAudio.currentTime = 0; }).catch(()=>{}); }
    }
  }

  function playNotificationAudioLoop(durationMs = 60000) {
    try {
      if (!notifAudio) return;
      if (notifPlaying && notifStopTimer) { clearTimeout(notifStopTimer); notifStopTimer = setTimeout(stopNotifAudio, durationMs); return; }
      const p = notifAudio.play();
      if (p !== undefined && p.catch) p.catch(()=>{});
      notifPlaying = true;
      notifAudio.onended = () => {
        if (!notifPlaying) return;
        try { notifAudio.currentTime = 0; notifAudio.play(); } catch(e){}
      };
      notifStopTimer = setTimeout(stopNotifAudio, durationMs);
    } catch(e){ console.error('Notification audio failed', e); }
  }
  function stopNotifAudio(){ notifPlaying=false; if (notifStopTimer){ clearTimeout(notifStopTimer); notifStopTimer=null;} if (notifAudio){ notifAudio.pause(); try{ notifAudio.currentTime=0; }catch(e){} } }

  // Only clear auth on leaving the page (not on file picker or after post)
  window.addEventListener('pagehide', () => clearAuth());
  window.addEventListener('beforeunload', () => clearAuth());

  // keepalive + fallback fetch every 10s for robustness
  setInterval(()=> fetch(`${API_BASE}/ping`).catch(()=>{}), 1000 * 60 * 3);
  setInterval(()=> loadPosts(), 10000);

  // init
  initUI();
  loadPosts();

})();
