/* PulseChat interaction upgrade. Existing inline functions remain the data layer. */
const baseExtensionHTML = extensionHTML;
const baseUpdateExtension = updateExtension;

function getPinnedChats() { return JSON.parse(localStorage.getItem(`pinned_chats_${currentUser}`) || '[]'); }
function savePinnedChats(pins) { localStorage.setItem(`pinned_chats_${currentUser}`, JSON.stringify(pins)); }
function togglePinnedChat(friend, event) {
  event?.stopPropagation();
  const pins = getPinnedChats(); const index = pins.indexOf(friend);
  if (index >= 0) pins.splice(index, 1); else pins.unshift(friend);
  savePinnedChats(pins); renderSidebar();
}
function showMobileSidebar() { document.getElementById('app-screen').classList.add('sidebar-open'); }

const baseSelectFriend = selectFriend;
selectFriend = function(friend) { baseSelectFriend(friend); document.getElementById('app-screen').classList.remove('sidebar-open'); };

const baseRenderSidebar = renderSidebar;
renderSidebar = function() {
  baseRenderSidebar();
  if (!currentUser) return;
  const pins = getPinnedChats(); const list = document.getElementById('friends-list');
  const rows = [...list.children];
  rows.sort((a,b) => pins.includes(b.querySelector('.user-profile-info > span')?.textContent.replace('@','')) - pins.includes(a.querySelector('.user-profile-info > span')?.textContent.replace('@','')));
  rows.forEach(row => {
    const friend = row.querySelector('.user-profile-info > span')?.textContent.replace('@',''); if (!friend) return;
    const pinned = pins.includes(friend); row.classList.toggle('pinned-chat', pinned);
    const button = document.createElement('button'); button.className = `pin-chat-btn ${pinned ? 'pinned' : ''}`; button.title = pinned ? 'Unpin chat' : 'Pin chat'; button.textContent = pinned ? '★' : '☆';
    button.onclick = event => togglePinnedChat(friend, event); row.appendChild(button);
  });
  rows.forEach(row => list.appendChild(row));
};

function gameState(e) {
  if (!e.game) e.game = { board: e.title === 'Chess' ? ['♜','♞','♝','♛','♚','♝','♞','♜','♟','♟','♟','♟','♟','♟','♟','♟','','','','','','','','','','','','','','','','','','','','','','','','','','','','','','','','','','','','','','','','','','','','','','','♙','♙','♙','♙','♙','♙','♙','♙','♖','♘','♗','♕','♔','♗','♘','♖'] : Array(9).fill(''), turn: e.mode === 'solo' ? currentUser : null, selected: null, log: [], started: Date.now(), prompt: '', score: {} };
  return e.game;
}
function canPlayGame(e) { return e.mode === 'solo' || (e.accepted && e.game?.turn === currentUser); }
function gameMessage(msgId, text) { const messages = DB.getMessages(); const m = messages.find(x => x.id === msgId); if (!m) return; const e = m.extension; const g = gameState(e); g.log.unshift(text); g.log = g.log.slice(0,8); DB.saveMessages(messages); renderMessages(false); }
function playGame(msgId, action, value) {
  const messages = DB.getMessages(); const m = messages.find(x => x.id === msgId); if (!m?.extension) return; const e = m.extension; const g = gameState(e);
  if (action === 'accept') { e.accepted = true; g.turn = m.sender; g.log.unshift(`${currentUser} accepted the challenge`); }
  else if (!canPlayGame(e)) return;
  else if (e.title === 'Tic-tac-toe' && action === 'cell') { if (g.board[value]) return; const mark = currentUser === m.sender ? 'X' : 'O'; g.board[value] = mark; if (win(g.board)) g.winner = currentUser; else if (g.board.every(Boolean)) g.winner = 'Draw'; else g.turn = otherPlayer(m, currentUser); }
  else if (e.title === 'Chess' && action === 'cell') { if (g.selected === null) { if (g.board[value]) g.selected = value; } else { const piece = g.board[g.selected]; if (piece) { g.board[value] = piece; g.board[g.selected] = ''; g.log.unshift(`${currentUser} moved ${piece}`); g.turn = e.mode === 'solo' ? currentUser : otherPlayer(m, currentUser); } g.selected = null; } }
  else if (e.title === 'Reaction speed' && action === 'start') { g.prompt = 'Now! Tap SCORE as quickly as you can.'; g.started = Date.now(); }
  else if (e.title === 'Reaction speed' && action === 'score' && g.prompt) { const time = Date.now() - g.started; g.score[currentUser] = time; g.prompt = `${currentUser}: ${time} ms`; g.turn = e.mode === 'solo' ? currentUser : otherPlayer(m, currentUser); }
  else if (action === 'submit') { const input = document.getElementById(`game-input-${msgId}`); const valueText = input?.value.trim(); if (!valueText) return; g.log.unshift(`${currentUser}: ${valueText}`); if (e.title === 'Guess the emoji' && /pizza/i.test(valueText)) g.winner = currentUser; g.turn = e.mode === 'solo' ? currentUser : otherPlayer(m, currentUser); }
  else if (e.title === 'Trivia' && action === 'answer') { g.winner = value === 'Pacific' ? currentUser : ''; g.prompt = value === 'Pacific' ? `${currentUser} got it right!` : 'Not quite — the answer was Pacific.'; }
  else if (e.title === 'Drawing challenge' && action === 'done') { g.log.unshift(`${currentUser} finished their drawing`); g.turn = e.mode === 'solo' ? currentUser : otherPlayer(m, currentUser); }
  DB.saveMessages(messages); renderMessages(false);
}
function otherPlayer(m, user) { return m.sender === user ? m.receiver : m.sender; }
function win(board) { return [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]].some(line => line.every(i => board[i] && board[i] === board[line[0]])); }
function gameInput(msgId, placeholder) { return `<div class="game-actions"><input id="game-input-${msgId}" placeholder="${placeholder}"><button onclick="playGame(${msgId},'submit')">Send</button></div>`; }
function gameHTML(m) {
  const e = m.extension, g = gameState(e); const locked = !canPlayGame(e); const title = escapeHTML(e.title);
  if (e.mode !== 'solo' && !e.accepted) return `<div class="extension-card game-card"><div class="extension-title">Game · ${title}</div><div class="game-status">Challenge waiting for acceptance.</div>${m.receiver === currentUser ? `<button class="poll-option" onclick="playGame(${m.id},'accept')">Accept & play</button>` : ''}</div>`;
  const status = g.winner ? (g.winner === 'Draw' ? 'It is a draw.' : `${g.winner} wins!`) : (locked ? `Waiting for @${g.turn}` : 'Your turn');
  let play = '';
  if (e.title === 'Tic-tac-toe') play = `<div class="game-board">${g.board.map((cell,i) => `<button ${locked||g.winner?'disabled':''} onclick="playGame(${m.id},'cell',${i})">${cell}</button>`).join('')}</div>`;
  else if (e.title === 'Chess') play = `<div class="game-board chess-board">${g.board.map((cell,i) => `<button class="${g.selected===i?'selected':''}" ${locked?'disabled':''} onclick="playGame(${m.id},'cell',${i})">${cell}</button>`).join('')}</div><div class="extension-meta">Tap a piece, then a square. This is a friendly free-move chess board.</div>`;
  else if (e.title === 'Guess the emoji') play = `<div class="game-prompt">🍕 Guess this emoji</div>${gameInput(m.id,'Your guess')}`;
  else if (e.title === 'Trivia') play = `<div class="game-prompt">Which is the largest ocean?</div><div class="game-actions"><button onclick="playGame(${m.id},'answer','Atlantic')">Atlantic</button><button onclick="playGame(${m.id},'answer','Pacific')">Pacific</button><button onclick="playGame(${m.id},'answer','Indian')">Indian</button></div>`;
  else if (e.title === 'Reaction speed') play = `<div class="game-prompt">${g.prompt || 'Test your speed.'}</div><div class="game-actions"><button onclick="playGame(${m.id},'start')">Start</button><button onclick="playGame(${m.id},'score')">Score!</button></div>`;
  else if (e.title === 'Drawing challenge') play = `<div class="game-prompt">Draw a rocket ship, then mark it done.</div><div class="game-actions"><button onclick="playGame(${m.id},'done')">I finished drawing</button></div>`;
  else if (e.title === 'Word battle') play = `<div class="game-prompt">Take turns with a word that starts with the last letter of the previous word.</div>${gameInput(m.id,'Type a word')}`;
  else play = `<div class="game-prompt">Ask a clever yes/no question. Take turns.</div>${gameInput(m.id,'Ask a question')}`;
  return `<div class="extension-card game-card"><div class="extension-title">Game · ${title}</div><div class="game-status">${status}</div>${play}<div class="game-log">${g.log.map(x => `<div>${escapeHTML(x)}</div>`).join('')}</div></div>`;
}

extensionHTML = function(message) { return message.extension?.type === 'game' ? gameHTML(message) : baseExtensionHTML(message); };
updateExtension = function(msgId, action, value) { if (action === 'accept') return playGame(msgId, action, value); return baseUpdateExtension(msgId, action, value); };

/* Reaction controls now require an intentional double-click. */
const originalRenderMessages = renderMessages;
renderMessages = function(forceScroll) {
  originalRenderMessages(forceScroll);
  document.querySelectorAll('.message').forEach(message => {
    const existing = message.onclick; message.onclick = null;
    message.ondblclick = event => { event.preventDefault(); const wrapper = message.closest('.message-wrapper'); const list = [...document.querySelectorAll('.message-wrapper')]; const index = list.indexOf(wrapper); const visible = DB.getMessages().filter(m => (m.sender === currentUser && m.receiver === activeFriend) || (m.sender === activeFriend && m.receiver === currentUser)); const msg = visible[index]; if (msg) toggleMsgPopover(event, msg.id); };
  });
};

/* Quest Crates: all progress and rewards remain local to the signed-in profile. */
const QUEST_DEFINITIONS = [
  { metric:'messages', target:5, gems:10, label:'Send 5 messages' }, { metric:'messages', target:20, gems:25, label:'Send 20 messages' }, { metric:'messages', target:50, gems:50, label:'Send 50 messages' },
  { metric:'images', target:1, gems:15, label:'Send 1 image' }, { metric:'images', target:5, gems:35, label:'Send 5 images' }, { metric:'images', target:15, gems:60, label:'Send 15 images' },
  { metric:'reactions', target:5, gems:10, label:'React 5 times' }, { metric:'reactions', target:25, gems:30, label:'React 25 times' }, { metric:'reactions', target:75, gems:75, label:'React 75 times' }
];
const FRAME_NAMES = { 'frame-gold':'Golden Halo', 'frame-neon':'Neon Cyan', 'frame-rose':'Rose Quartz', 'frame-void':'Void Purple', 'frame-sakura':'Sakura Bloom', 'frame-ocean':'Ocean Wave', 'frame-cosmic':'Cosmic Glow', 'frame-sunflower':'Sunflower Ring', 'frame-ice':'Ice Crown', 'frame-dragon':'Dragon Flame', 'frame-royal':'Royal Laurel' };
const CRATES = { common:{ cost:50, frames:['frame-sakura','frame-ocean','frame-sunflower'] }, rare:{ cost:120, frames:['frame-cosmic','frame-ice','frame-royal'] }, epic:{ cost:250, frames:['frame-dragon','frame-royal','frame-cosmic'] } };
function questKey() { return `quest_crates_${currentUser}`; }
function getQuestProfile() {
  const fallback = { gems:0, stats:{messages:0,images:0,reactions:0}, claimed:[], inventory:['frame-gold','frame-neon','frame-rose','frame-void'] };
  if (!currentUser) return fallback;
  const saved = JSON.parse(localStorage.getItem(questKey()) || 'null') || fallback;
  saved.stats = { ...fallback.stats, ...(saved.stats || {}) }; saved.claimed ||= []; saved.inventory ||= fallback.inventory;
  const currentFrame = DB.getUsers()[currentUser]?.frame; if (currentFrame && !saved.inventory.includes(currentFrame)) saved.inventory.push(currentFrame);
  return saved;
}
function saveQuestProfile(profile) { if (currentUser) localStorage.setItem(questKey(), JSON.stringify(profile)); }
function rewardQuestProgress(metric, amount=1) {
  if (!currentUser) return; const profile = getQuestProfile(); profile.stats[metric] += amount;
  QUEST_DEFINITIONS.forEach(quest => { const key = `${quest.metric}-${quest.target}`; if (quest.metric === metric && profile.stats[metric] >= quest.target && !profile.claimed.includes(key)) { profile.claimed.push(key); profile.gems += quest.gems; } });
  saveQuestProfile(profile); if (!document.getElementById('shop-modal').classList.contains('hidden')) renderQuestShop();
}
function openShop() { renderQuestShop(); document.getElementById('shop-modal').classList.remove('hidden'); }
function closeShop() { document.getElementById('shop-modal').classList.add('hidden'); }
function renderQuestShop() {
  const profile = getQuestProfile(); document.getElementById('gem-balance').textContent = profile.gems;
  const list = document.getElementById('quest-list'); list.innerHTML = '';
  QUEST_DEFINITIONS.forEach(quest => { const done = profile.stats[quest.metric] >= quest.target; const card = document.createElement('div'); card.className = 'quest-card'; card.innerHTML = `<strong>${escapeHTML(quest.label)}</strong><small>${Math.min(profile.stats[quest.metric],quest.target)} / ${quest.target}${done ? ' · complete' : ''}</small><div class="quest-progress"><i style="width:${Math.min(100, profile.stats[quest.metric] / quest.target * 100)}%"></i></div><div class="quest-reward">💎 ${quest.gems} gems</div>`; list.appendChild(card); });
  const inventory = document.getElementById('frame-inventory'); inventory.innerHTML = '';
  const current = DB.getUsers()[currentUser]?.frame || '';
  profile.inventory.forEach(frame => { const item = document.createElement('button'); item.className = `frame-choice ${current === frame ? 'active' : ''}`; item.textContent = FRAME_NAMES[frame] || frame; item.onclick = () => { changeProfileFrame(frame); renderQuestShop(); syncFrameSelect(); }; inventory.appendChild(item); });
}
function buyCrate(tier) {
  const crate = CRATES[tier]; const profile = getQuestProfile(); if (profile.gems < crate.cost) return alert(`You need ${crate.cost - profile.gems} more gems for this crate.`);
  profile.gems -= crate.cost; const available = crate.frames.filter(frame => !profile.inventory.includes(frame)); const duplicateReward = !available.length;
  const reward = (available.length ? available : crate.frames)[Math.floor(Math.random() * (available.length ? available.length : crate.frames.length))];
  if (!profile.inventory.includes(reward)) profile.inventory.push(reward); else profile.gems += Math.ceil(crate.cost * .2);
  saveQuestProfile(profile); const result = document.getElementById('crate-result'); result.innerHTML = duplicateReward ? `✨ Duplicate <strong>${FRAME_NAMES[reward]}</strong> converted to bonus gems.` : `✨ Crate opened! You unlocked <strong>${FRAME_NAMES[reward]}</strong>.`; result.classList.remove('hidden'); result.classList.add('show'); renderQuestShop(); syncFrameSelect();
}
function syncFrameSelect() {
  const select = document.getElementById('frame-select'); if (!select || !currentUser) return; const current = DB.getUsers()[currentUser]?.frame || ''; const profile = getQuestProfile();
  Object.entries(FRAME_NAMES).forEach(([frame,name]) => { let option = [...select.options].find(item => item.value === frame); if (!option && profile.inventory.includes(frame)) { option = document.createElement('option'); option.value = frame; option.textContent = name; select.appendChild(option); } if (option) option.disabled = !profile.inventory.includes(frame); });
  select.value = current;
}
const openSettingsWithFrames = openSettings;
openSettings = function() { openSettingsWithFrames(); syncFrameSelect(); };
const sendMessageWithQuests = sendMessage;
sendMessage = function() { const text = document.getElementById('message-input')?.value.trim(); const attachment = currentAttachment; const newMessage = !editingMsgId && activeFriend && (text || attachment); sendMessageWithQuests(); if (newMessage) { rewardQuestProgress('messages'); if (attachment?.type === 'image') rewardQuestProgress('images'); } };
const reactToMessageWithQuests = reactToMsg;
reactToMsg = function(messageId, emoji) { const message = DB.getMessages().find(m => m.id === messageId); const isNewReaction = message && !message.reactions?.[currentUser]; reactToMessageWithQuests(messageId, emoji); if (isNewReaction) rewardQuestProgress('reactions'); };

/* Keep Quests separate from the crate shop, with transparent crate rewards. */
Object.assign(FRAME_NAMES, { 'frame-rose-thorn':'Rose Thorn', 'frame-butterfly':'Butterfly Glow', 'frame-starlight':'Starlight Ring', 'frame-heart':'Heart Halo', 'frame-rainbow':'Rainbow Cloud', 'frame-pirate':'Pirate Wheel', 'frame-autumn':'Autumn Leaves', 'frame-moon':'Moonlit Sky', 'frame-cat':'Cat Paws', 'frame-candy':'Candy Pop', 'frame-holiday':'Holiday Wreath' });
CRATES.common.frames.push('frame-sakura','frame-sunflower','frame-heart','frame-autumn');
CRATES.rare.frames.push('frame-ocean','frame-butterfly','frame-ice','frame-rainbow','frame-cat');
CRATES.epic.frames.push('frame-cosmic','frame-dragon','frame-royal','frame-rose-thorn','frame-starlight','frame-pirate','frame-moon','frame-candy','frame-holiday');
const CRATE_PREVIEWS = { common:['Sakura Bloom','Sunflower Ring','Heart Halo','Autumn Leaves'], rare:['Ocean Wave','Butterfly Glow','Ice Crown','Rainbow Cloud','Cat Paws'], epic:['Cosmic Glow','Dragon Flame','Royal Laurel','Rose Thorn','Starlight Ring','Pirate Wheel','Moonlit Sky','Candy Pop','Holiday Wreath'] };
function buildQuestMenu() {
  if (document.getElementById('quest-modal')) return;
  document.body.insertAdjacentHTML('beforeend', '<div id="quest-modal" class="modal hidden"><div class="card quest-modal-card"><div class="shop-topline"><div><span class="shop-kicker">QUESTS</span><h2>Complete actions. Earn gems.</h2></div><button class="icon-btn" onclick="closeQuestMenu()" title="Close quests">×</button></div><div class="gem-wallet">💎 <strong id="quest-gem-balance">0</strong><span>Gems</span></div><div class="quest-area"><h3>Active quests</h3><div id="quest-list-standalone" class="quest-list"></div></div></div></div>');
  const toolbar = document.querySelector('.sidebar-header > div[style*="display:flex"]');
  if (toolbar) { const button = document.createElement('button'); button.className = 'icon-btn'; button.title = 'Quests'; button.textContent = '📋'; button.onclick = openQuestMenu; toolbar.insertBefore(button, toolbar.firstChild); }
  document.querySelectorAll('.crate-card').forEach(card => { const tier = [...card.classList].find(name => CRATE_PREVIEWS[name]); if (!tier || card.querySelector('.crate-info')) return; const info = document.createElement('span'); info.className = 'crate-info'; info.textContent = '?'; info.title = 'View possible rewards'; info.onclick = event => showCrateInfo(tier, event); card.appendChild(info); });
}
const renderQuestShopWithSeparateMenu = renderQuestShop;
renderQuestShop = function() { renderQuestShopWithSeparateMenu(); const standalone = document.getElementById('quest-list-standalone'); const original = document.getElementById('quest-list'); const gems = document.getElementById('quest-gem-balance'); if (standalone && original) standalone.innerHTML = original.innerHTML; if (gems) gems.textContent = getQuestProfile().gems; };
function openQuestMenu() { renderQuestShop(); document.getElementById('quest-modal').classList.remove('hidden'); }
function closeQuestMenu() { document.getElementById('quest-modal').classList.add('hidden'); }
function showCrateInfo(tier, event) { event.preventDefault(); event.stopPropagation(); document.querySelectorAll('.crate-info-popover').forEach(menu => menu.remove()); const menu = document.createElement('div'); menu.className = 'crate-info-popover'; menu.innerHTML = `<strong>Possible ${tier} rewards</strong>${CRATE_PREVIEWS[tier].map(name => `<span>✦ ${name}</span>`).join('')}`; event.currentTarget.parentElement.appendChild(menu); }
/* Quest Crates is paused. Its UI is not initialized. */
sendMessage = sendMessageWithQuests;
reactToMsg = reactToMessageWithQuests;
openSettings = openSettingsWithFrames;

/* Hubs: local group chats with invitations and member controls. */
let activeHub = null;
let hubCreationInProgress = false;
const directSendMessage = sendMessage;
function getHubs() { return JSON.parse(localStorage.getItem('hubs_data') || '[]'); }
function saveHubs(hubs) { localStorage.setItem('hubs_data', JSON.stringify(hubs)); }
function hubById(id) { return getHubs().find(hub => hub.id === id); }
function safeHubText(value='') { const el = document.createElement('div'); el.textContent = value; return el.innerHTML; }
function hubImageSource(value) {
  if (typeof value !== 'string') return '';
  const source = value.trim();
  return /^(?:data:image\/(?:png|jpe?g|webp|gif);base64,|https?:\/\/)/i.test(source) ? source : '';
}
function addHubModals() {
  if (document.getElementById('hub-create-modal')) return;
  document.body.insertAdjacentHTML('beforeend', `<div id="hub-create-modal" class="modal hidden hub-modal"><div class="card"><h3>Create a Hub</h3><label class="hub-form-label">Hub name</label><input id="hub-name" placeholder="Study Squad"><label class="hub-form-label">Description</label><textarea id="hub-description" placeholder="What is this hub for?"></textarea><label class="hub-form-label">Type</label><select id="hub-type"><option>School</option><option>Gaming</option><option>Work</option><option>Productivity</option></select><label class="hub-form-label">Hub icon image (optional)</label><input id="hub-icon-file" type="file" accept="image/png,image/jpeg,image/webp"><label class="hub-form-label">Chat background image (optional)</label><input id="hub-bg-file" type="file" accept="image/png,image/jpeg,image/webp"><label class="hub-form-label">Header banner image (optional)</label><input id="hub-banner-file" type="file" accept="image/png,image/jpeg,image/webp"><label class="hub-form-label">Invite usernames, separated by commas</label><input id="hub-invites" placeholder="alex, sam"><button onclick="createHub()">Create Hub</button><button class="secondary" onclick="closeHubModal('hub-create-modal')">Cancel</button></div></div><div id="hub-settings-modal" class="modal hidden hub-modal"><div class="card"><h3>Hub settings</h3><label class="hub-form-label">Name</label><input id="hub-edit-name"><label class="hub-form-label">Description</label><textarea id="hub-edit-description"></textarea><label class="hub-form-label">Invite member</label><div class="input-row"><input id="hub-add-member" placeholder="Username"><button onclick="inviteToHub()">Invite</button></div><label class="hub-form-label">Members</label><div id="hub-members" class="hub-member-list"></div><button onclick="saveHubSettings()">Save changes</button><button class="secondary" onclick="closeHubModal('hub-settings-modal')">Close</button></div></div>`);
}
function closeHubModal(id) { document.getElementById(id).classList.add('hidden'); }
function fileAsData(inputId, done) { const file = document.getElementById(inputId)?.files[0]; if (!file) return done(''); if (!file.type.startsWith('image/') || file.size > 900 * 1024) { alert('Use a PNG, JPG, or WebP image under 900 KB for Hub images.'); hubCreationInProgress = false; return; } const reader = new FileReader(); reader.onerror = () => { hubCreationInProgress = false; alert('That image could not be read.'); }; reader.onload = e => done(e.target.result); reader.readAsDataURL(file); }
function openHubCreator() { addHubModals(); const modal = document.getElementById('hub-create-modal'); if (!modal) return alert('Hub creator could not load. Please refresh the page once.'); modal.classList.remove('hidden'); }
function createHub() {
  if (hubCreationInProgress) return;
  const name = document.getElementById('hub-name').value.trim(), description = document.getElementById('hub-description').value.trim(), type = document.getElementById('hub-type').value;
  if (!name) return alert('Give your Hub a name.');
  hubCreationInProgress = true;
  const users = DB.getUsers(); const rawInvites = document.getElementById('hub-invites').value.split(',').map(x => x.trim()).filter(Boolean); const invites = rawInvites.map(x => Object.keys(users).find(user => user.toLowerCase() === x.toLowerCase())).filter(user => user && user !== currentUser);
  fileAsData('hub-icon-file', icon => fileAsData('hub-bg-file', background => fileAsData('hub-banner-file', banner => { const hubs = getHubs(); const hub = { id:Date.now(), name, description, type, owner:currentUser, members:[currentUser], invites, icon, background, banner, messages:[] }; hubs.push(hub); try { saveHubs(hubs); } catch (error) { hubCreationInProgress = false; return alert('Hub storage is full. Choose smaller images or remove an old Hub.'); } hubCreationInProgress = false; closeHubModal('hub-create-modal'); selectHub(hub.id); })));
}
function selectHub(id) {
  const hub = hubById(id); if (!hub || !hub.members.includes(currentUser)) return;
  const icon = hubImageSource(hub.icon), headerImage = hubImageSource(hub.banner), chatImage = hubImageSource(hub.background);
  activeHub = id; activeFriend = null; ensureHubBanner(); const banner = document.getElementById('hub-banner-info'); const image = icon ? `<img class="hub-banner-icon" src="${icon}" alt="${safeHubText(hub.name)} icon">` : `<div class="hub-banner-icon fallback">${safeHubText(hub.name).charAt(0).toUpperCase()}</div>`; banner.innerHTML = `${image}<div class="hub-banner-copy"><div class="hub-banner-name">${safeHubText(hub.name)}</div><span class="hub-banner-meta">${safeHubText(hub.type)} · ${hub.members.length} member${hub.members.length === 1 ? '' : 's'}</span></div>`; banner.classList.add('visible'); const header=document.getElementById('chat-header'); header.style.backgroundImage = headerImage ? `linear-gradient(rgba(15,23,42,.58),rgba(15,23,42,.58)),url('${headerImage}')` : ''; header.style.backgroundSize = headerImage ? 'cover' : ''; header.style.backgroundPosition = headerImage ? 'center' : ''; document.querySelector('.main-chat').classList.add('hub-active'); document.getElementById('chat-header-avatar-container').classList.add('hidden'); document.getElementById('chat-title').innerHTML = '';
  document.getElementById('chat-input-container').classList.remove('hidden'); document.getElementById('hub-settings-btn').classList.remove('hidden'); document.getElementById('pinned-messages-btn').classList.add('hidden'); const messages = document.getElementById('messages-list'); messages.classList.toggle('hub-chat-bg', !!chatImage); messages.style.backgroundImage = chatImage ? `url('${chatImage}')` : '';
  renderHubMessages(true); renderSidebar(); document.getElementById('app-screen').classList.remove('sidebar-open');
}
function ensureHubBanner() { if (document.getElementById('hub-banner-info')) return; const banner=document.createElement('div'); banner.id='hub-banner-info'; banner.className='hub-banner-info'; document.getElementById('mobile-conversations').insertAdjacentElement('afterend', banner); }
const selectFriendWithHubBanner = selectFriend;
selectFriend = function(friend) { activeHub = null; const banner = document.getElementById('hub-banner-info'); if (banner) banner.classList.remove('visible'); document.querySelector('.main-chat').classList.remove('hub-active'); const header = document.getElementById('chat-header'); header.style.backgroundImage = ''; header.style.backgroundSize = ''; header.style.backgroundPosition = ''; const messages = document.getElementById('messages-list'); messages.classList.remove('hub-chat-bg'); applyWallpaper(localStorage.getItem('wallpaper') || ''); document.getElementById('hub-settings-btn').classList.add('hidden'); document.getElementById('pinned-messages-btn').classList.remove('hidden'); selectFriendWithHubBanner(friend); };
function renderHubMessages(scroll) {
  const hub = hubById(activeHub); if (!hub) return; const list = document.getElementById('messages-list'); list.innerHTML = '';
  hub.messages.forEach(message => { const sent = message.sender === currentUser; const row = document.createElement('div'); row.className = `message-wrapper ${sent ? 'sent' : 'received'}`; row.innerHTML = `<div class="message-body-row"><img class="avatar" src="${(DB.getUsers()[message.sender]?.pfp) || DEFAULT_AVATAR}" style="width:26px;height:26px;"><div class="message ${sent ? 'sent' : 'received'}"><div class="hub-message-name">@${safeHubText(message.sender)}</div>${message.attachment?.type === 'image' ? `<img src="${message.attachment.data}" class="attachment-img">` : ''}${message.text ? `<div>${parseTextLinks(message.text)}</div>` : ''}<div style="font-size:10px;opacity:.7;text-align:right;">${message.timestamp}</div></div></div>`; list.appendChild(row); }); if (scroll) list.scrollTop = list.scrollHeight;
}
sendMessage = function() { if (!activeHub) return directSendMessage(); const input = document.getElementById('message-input'), text = input.value.trim(); if (!text && !currentAttachment) return; const hubs = getHubs(), hub = hubs.find(item => item.id === activeHub); if (!hub) return; hub.messages.push({id:Date.now(),sender:currentUser,text,attachment:currentAttachment,timestamp:new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}); saveHubs(hubs); input.value=''; removeAttachment(); renderHubMessages(true); };
function openHubSettings() { const hub = hubById(activeHub); if (!hub) return; addHubModals(); ensureHubAppearanceSettings(); if (hub.owner !== currentUser) return alert('Only the Hub owner can change settings or manage members.'); document.getElementById('hub-edit-name').value = hub.name; document.getElementById('hub-edit-description').value = hub.description; renderHubMembers(hub); document.getElementById('hub-settings-modal').classList.remove('hidden'); }
function ensureHubAppearanceSettings() { if (document.getElementById('hub-edit-icon')) return; document.getElementById('hub-members').insertAdjacentHTML('afterend', '<label class="hub-form-label">Change Hub icon</label><input id="hub-edit-icon" type="file" accept="image/png,image/jpeg,image/webp"><label class="hub-form-label">Change chat background</label><input id="hub-edit-background" type="file" accept="image/png,image/jpeg,image/webp"><label class="hub-form-label">Change header banner</label><input id="hub-edit-banner" type="file" accept="image/png,image/jpeg,image/webp">'); }
function renderHubMembers(hub) { const target = document.getElementById('hub-members'); target.innerHTML = ''; hub.members.forEach(member => { const chip = document.createElement('div'); chip.className='hub-member-chip'; chip.innerHTML = `@${safeHubText(member)}${member !== hub.owner ? `<button title="Remove member" onclick="removeHubMember('${member}')">×</button>` : ' · Owner'}`; target.appendChild(chip); }); }
function inviteToHub() { const name = document.getElementById('hub-add-member').value.trim(); const users = DB.getUsers(); const actual = Object.keys(users).find(user => user.toLowerCase() === name.toLowerCase()); const hubs=getHubs(), hub=hubs.find(item=>item.id===activeHub); if (!actual) return alert('User not found.'); if (hub.members.includes(actual) || hub.invites.includes(actual)) return alert('That user is already in this Hub or has an invite.'); hub.invites.push(actual); saveHubs(hubs); document.getElementById('hub-add-member').value=''; alert(`Invite sent to @${actual}.`); }
function removeHubMember(member) { const hubs=getHubs(), hub=hubs.find(item=>item.id===activeHub); if (!hub || member===hub.owner) return; hub.members=hub.members.filter(user=>user!==member); saveHubs(hubs); renderHubMembers(hub); renderSidebar(); }
function saveHubSettings() {
  const hubs=getHubs(), hub=hubs.find(item=>item.id===activeHub); if (!hub) return;
  hub.name=document.getElementById('hub-edit-name').value.trim() || hub.name;
  hub.description=document.getElementById('hub-edit-description').value.trim();
  const updateAppearance = (inputId, property, done) => {
    const file=document.getElementById(inputId)?.files[0];
    if (!file) return done();
    if (!file.type.startsWith('image/') || file.size > 900 * 1024) return alert('Use a PNG, JPG, or WebP image under 900 KB.');
    const reader=new FileReader(); reader.onload=e=>{hub[property]=e.target.result; done();}; reader.readAsDataURL(file);
  };
  updateAppearance('hub-edit-icon','icon', () => {
    updateAppearance('hub-edit-background','background', () => {
      updateAppearance('hub-edit-banner','banner', () => {
        try { saveHubs(hubs); } catch (error) { return alert('Hub storage is full. Choose smaller images.'); }
        closeHubModal('hub-settings-modal'); selectHub(hub.id);
      });
    });
  });
}
const sidebarWithHubs = renderSidebar;
renderSidebar = function() {
  document.getElementById('hub-sidebar-section')?.remove(); sidebarWithHubs(); if (!currentUser) return;
  const list = document.getElementById('friends-list'), hubs = getHubs();
  const visible = hubs.filter(hub => hub.members.includes(currentUser)).filter((hub,index,all) => all.findIndex(item => item.owner === hub.owner && item.name === hub.name && item.type === hub.type) === index);
  const invites = hubs.filter(hub => hub.invites.includes(currentUser));
  if (visible.length || invites.length) {
    const section=document.createElement('div'); section.id='hub-sidebar-section'; section.className='section'; section.innerHTML='<div class="hub-list-title">Hubs</div><ul class="item-list hub-list"></ul>'; const hubList=section.querySelector('.hub-list'); list.parentElement.parentElement.insertBefore(section,list.parentElement);
    visible.forEach(hub => { const row=document.createElement('li'); const icon = hubImageSource(hub.icon); row.className=`hub-row ${activeHub===hub.id?'active-friend':''}`; row.innerHTML=`<div class="user-profile-info">${icon ? `<img class="hub-icon" src="${icon}" alt="">` : `<div class="hub-icon">#</div>`}<div><span>${safeHubText(hub.name)}</span><small>${safeHubText(hub.type)} · ${hub.members.length} member${hub.members.length === 1 ? '' : 's'}</small></div></div>`; row.onclick=()=>selectHub(hub.id); hubList.appendChild(row); });
    invites.forEach(hub => { const row=document.createElement('li'); row.innerHTML=`<span>Invite: ${safeHubText(hub.name)}</span><button>Join</button>`; row.querySelector('button').onclick=event=>{event.stopPropagation(); acceptHubInvite(hub.id);}; hubList.appendChild(row); });
  }
};
function acceptHubInvite(id) { const hubs=getHubs(), hub=hubs.find(item=>item.id===id); if (!hub) return; hub.invites=hub.invites.filter(user=>user!==currentUser); if (!hub.members.includes(currentUser)) hub.members.push(currentUser); saveHubs(hubs); selectHub(id); }
addHubModals();
if (currentUser) renderSidebar();
window.openHubCreator = openHubCreator;
window.createHub = createHub;
window.closeHubModal = closeHubModal;
window.openHubSettings = openHubSettings;

/* Mobile interaction polish: use the existing drawer control, respect keyboards and safe viewport height. */
function updateMobileViewport() {
  const height = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty('--mobile-app-height', `${Math.round(height)}px`);
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', updateMobileViewport);
  window.visualViewport.addEventListener('scroll', updateMobileViewport);
}
window.addEventListener('resize', updateMobileViewport);
updateMobileViewport();
document.addEventListener('focusin', event => {
  if (event.target.id === 'message-input') setTimeout(() => document.getElementById('messages-list')?.scrollTo({ top: document.getElementById('messages-list').scrollHeight, behavior:'smooth' }), 120);
});
document.addEventListener('click', event => {
  const app = document.getElementById('app-screen');
  if (!app?.classList.contains('sidebar-open')) return;
  if (event.target.closest('.sidebar') || event.target.closest('#mobile-conversations')) return;
  app.classList.remove('sidebar-open');
});

/* Search behaves consistently regardless of username capitalization. */
const originalFriendRequest = sendFriendRequest;
sendFriendRequest = function() { const field = document.getElementById('search-username'); const users = DB.getUsers(); const actual = Object.keys(users).find(name => name.toLowerCase() === field.value.trim().replace(/^@/, '').toLowerCase()); if (actual) field.value = actual; originalFriendRequest(); };

/* Pin individual messages and make them easy to find again. */
function conversationMessages() {
  return activeFriend ? DB.getMessages().filter(m => (m.sender === currentUser && m.receiver === activeFriend) || (m.sender === activeFriend && m.receiver === currentUser)) : [];
}
function pinnedPreview(message) {
  if (message.text) return message.text;
  if (message.extension?.type === 'note') return message.extension.title;
  if (message.extension) return `${message.extension.type}: ${message.extension.title || ''}`;
  if (message.attachment) return `Attachment: ${message.attachment.name || 'file'}`;
  return 'Message';
}
function togglePinnedMessage(messageId, event) {
  event?.stopPropagation();
  const messages = DB.getMessages(); const message = messages.find(m => m.id === messageId); if (!message) return;
  message.pinned = !message.pinned;
  DB.saveMessages(messages);
  activePopoverMsgId = null; activeMoreMenuMsgId = null;
  renderMessages(false);
}
function renderPinnedMessagesMenu() {
  const menu = document.getElementById('pinned-messages-menu'); if (!menu) return;
  const pinned = conversationMessages().filter(m => m.pinned);
  menu.innerHTML = `<div class="pinned-menu-title"><span>Pinned messages</span><span>${pinned.length}</span></div>`;
  if (!pinned.length) { menu.innerHTML += '<div class="pinned-message-empty">No pinned messages yet</div>'; return; }
  pinned.forEach(message => {
    const item = document.createElement('button'); item.className = 'pinned-message-item';
    item.innerHTML = `📌 <small>${escapeHTML(pinnedPreview(message))}</small>`;
    item.onclick = () => jumpToPinnedMessage(message.id);
    menu.appendChild(item);
  });
}
function togglePinnedMessages() {
  if (!activeFriend) return;
  const menu = document.getElementById('pinned-messages-menu');
  renderPinnedMessagesMenu(); menu.classList.toggle('hidden');
}
function jumpToPinnedMessage(messageId) {
  document.getElementById('pinned-messages-menu').classList.add('hidden');
  const target = document.querySelector(`.message-wrapper[data-message-id="${messageId}"]`);
  if (!target) return;
  target.scrollIntoView({ behavior:'smooth', block:'center' });
  target.classList.remove('pin-jump'); void target.offsetWidth; target.classList.add('pin-jump');
}

const renderMessagesWithDoubleClick = renderMessages;
renderMessages = function(forceScroll) {
  renderMessagesWithDoubleClick(forceScroll);
  const shown = conversationMessages();
  document.querySelectorAll('.message-wrapper').forEach((wrapper, index) => {
    const message = shown[index]; if (!message) return;
    wrapper.dataset.messageId = message.id;
    wrapper.classList.toggle('message-pinned', !!message.pinned);
  });
  if (activePopoverMsgId) {
    const active = shown.find(m => m.id === activePopoverMsgId);
    const popover = document.querySelector('.msg-popover');
    if (active && popover && !popover.querySelector('.pin-message-popover')) {
      const pin = document.createElement('button'); pin.className = `pin-message-popover ${active.pinned ? 'is-pinned' : ''}`;
      pin.title = active.pinned ? 'Unpin message' : 'Pin message'; pin.textContent = '📌';
      pin.onclick = event => togglePinnedMessage(active.id, event);
      popover.appendChild(pin);
    }
  }
  const menu = document.getElementById('pinned-messages-menu'); if (menu && !menu.classList.contains('hidden')) renderPinnedMessagesMenu();
};

/* Smart Context: high-confidence suggestions only; every action remains opt-in. */
function smartContextFor(message) {
  if (!message?.text || message.contextDismissed) return null;
  const text = message.text.trim().toLowerCase();
  const locationRequest = /\b(where are you|where r u|where you at|share (your )?location|send (your )?location)\b/.test(text);
  const outside = /\b(i['’]?m|i am|im)\s+(already\s+)?outside\b/.test(text);
  const reminder = /\b(remind me|reminder|don't let me forget|do not let me forget|google calendar|calendar reminder|let'?s meet|meeting)\b/.test(text) && /\b(today|tomorrow|tonight|next |at \d|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(text);
  const task = /\b(google tasks?|add (?:this|it) to (?:my )?tasks?|make (?:this|it) a task|to[- ]do)\b/.test(text);
  if (locationRequest || outside) return { type:'location', text: outside ? 'Looks like they have arrived. Choose a quick reply?' : 'They are asking for your location.', actions: outside ? [['coming','🚪 Coming'],['five','⏳ 5 min'],['location','📍 Share location']] : [['location','📍 Share location']] };
  if (task) return { type:'task', text:'This sounds like a task. Add it to a shared to-do list?', actions:[['task','✓ Create task']] };
  if (reminder) return { type:'reminder', text:'This mentions a time or meeting. Create a reminder card?', actions:[['calendar','☆ Create reminder']] };
  return null;
}
function dismissSmartContext(messageId) {
  const messages = DB.getMessages(); const message = messages.find(m => m.id === messageId); if (!message) return;
  message.contextDismissed = true; DB.saveMessages(messages); renderMessages(false);
}
function smartCalendarDefault() {
  const date = new Date(); date.setDate(date.getDate() + 1); date.setHours(17,0,0,0);
  const offset = date.getTimezoneOffset(); return new Date(date.getTime() - offset * 60000).toISOString().slice(0,16);
}
function smartContextAction(messageId, action) {
  const message = DB.getMessages().find(m => m.id === messageId); if (!message) return;
  if (action === 'location') { dismissSmartContext(messageId); shareLocation(); return; }
  if (action === 'coming' || action === 'five') {
    const input = document.getElementById('message-input'); input.value = action === 'coming' ? "I'm coming now." : "I'll be there in 5 minutes."; dismissSmartContext(messageId); sendMessage(); return;
  }
  if (action === 'calendar') {
    dismissSmartContext(messageId); openExtension('calendar');
    document.getElementById('ext-title').value = message.text.slice(0,80);
    document.getElementById('ext-date').value = smartCalendarDefault();
    return;
  }
  if (action === 'task') {
    dismissSmartContext(messageId); openExtension('todo');
    document.getElementById('ext-title').value = 'New task';
    document.getElementById('ext-items').value = message.text.slice(0,120);
  }
}
function smartContextCard(message, context) {
  const actions = context.actions.map(([action,label]) => `<button onclick="smartContextAction(${message.id},'${action}')">${label}</button>`).join('');
  return `<div class="smart-context-card"><div class="smart-context-heading"><span>✦ Smart Context</span><button title="Dismiss suggestion" onclick="dismissSmartContext(${message.id})">×</button></div><div class="smart-context-text">${context.text}</div><div class="smart-context-actions">${actions}</div></div>`;
}
const renderMessagesWithPins = renderMessages;
renderMessages = function(forceScroll) {
  renderMessagesWithPins(forceScroll);
  const shown = conversationMessages();
  document.querySelectorAll('.message-wrapper').forEach((wrapper, index) => {
    const message = shown[index], context = smartContextFor(message);
    if (message && context && !wrapper.querySelector('.smart-context-card')) wrapper.insertAdjacentHTML('beforeend', smartContextCard(message, context));
  });
};
