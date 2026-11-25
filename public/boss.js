// 보스 표시 공통 코드. 화면(프로젝터)과 폰에서 같이 씁니다.
// 상태는 .boss 요소의 클래스로 바뀝니다: enraged(분노) warn(반격 예고) attack(반격) hurt(피격) dead(쓰러짐)
// small=true 이면 폰용 작은 이미지를 씁니다.
function bossHTML(small) {
  const s = small ? '_s' : '';
  const img = (k) => `<img class="b-img b-${k}" src="/img/boss_${k}${s}.webp" alt="" draggable="false">`;
  return `<div class="b-shadow"></div><div class="b-wrap"><div class="b-body">${img('normal')}${img('rage')}${img('hurt')}${img('dead')}</div></div>`;
}

// 맞았을 때: 찌그러지며 번쩍 + 잠깐 아픈 표정
function bossHit(el, strong) {
  const body = el.querySelector('.b-body');
  if (!body) return;
  body.animate(
    [{ transform: 'scale(.93,1.06)', filter: 'brightness(1.9)' }, { transform: 'scale(1.02,.99)', filter: 'brightness(1.2)', offset: 0.6 }, { transform: 'scale(1)', filter: 'brightness(1)' }],
    { duration: strong ? 190 : 130, easing: 'ease-out' }
  );
  if (el.classList.contains('dead')) return;
  el.classList.add('hurt');
  clearTimeout(el._hurtT);
  el._hurtT = setTimeout(() => el.classList.remove('hurt'), strong ? 170 : 110);
}

const BOSS_CSS = `
.boss { position:relative; }
.boss .b-wrap { position:absolute; inset:0; transform-origin:50% 92%; animation:bossIdle 2.4s ease-in-out infinite; }
.boss .b-body { position:absolute; inset:0; transform-origin:50% 92%; }
.boss .b-img { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; opacity:0; pointer-events:none; -webkit-user-drag:none; user-select:none; }
.boss .b-normal { opacity:1; }
.boss.hurt .b-normal { opacity:0; } .boss.hurt .b-hurt { opacity:1; }
.boss.enraged .b-normal, .boss.enraged .b-hurt { opacity:0; } .boss.enraged .b-rage { opacity:1; }
.boss.dead .b-normal, .boss.dead .b-hurt, .boss.dead .b-rage { opacity:0; } .boss.dead .b-dead { opacity:1; }
.boss .b-shadow { position:absolute; left:16%; right:16%; bottom:1%; height:9%; border-radius:50%; background:radial-gradient(closest-side, rgba(0,0,0,.6), transparent); animation:shadowIdle 2.4s ease-in-out infinite; }
.boss .b-wrap { filter:drop-shadow(0 0 1.2vmin rgba(190,120,255,.45)); transition:filter .25s; }
.boss.enraged .b-wrap { animation:bossRage .45s ease-in-out infinite; filter:drop-shadow(0 0 2vmin rgba(255,110,30,.8)); }
.boss.warn .b-wrap { animation:bossWarn .28s steps(2) infinite; }
.boss.attack .b-wrap { animation:bossAtk .11s linear infinite; filter:sepia(1) saturate(5.5) hue-rotate(-38deg) brightness(1.02) drop-shadow(0 0 3vmin #ff1a1a); }
.boss.enraged.attack .b-wrap { filter:brightness(1.35) saturate(1.4) drop-shadow(0 0 3vmin #ffe45c); }
.boss.dead .b-wrap { animation:bossDie 1.5s cubic-bezier(.3,0,.5,1) forwards; }
.boss.dead .b-shadow { animation:none; }
@keyframes bossIdle { 0%,100% { transform:translateY(0) scale(1,1); } 50% { transform:translateY(-2.2%) scale(1.015,.985); } }
@keyframes shadowIdle { 0%,100% { transform:scale(1); opacity:1; } 50% { transform:scale(.9); opacity:.75; } }
@keyframes bossRage { 0%,100% { transform:translate(0,0) rotate(-1.6deg) scale(1.04); } 50% { transform:translate(0,-2%) rotate(1.6deg) scale(1.06,1.03); } }
@keyframes bossWarn { 0% { transform:scale(1.02); filter:brightness(1); } 100% { transform:scale(1.05); filter:brightness(1.6) drop-shadow(0 0 3vmin #ffb020); } }
@keyframes bossAtk { 0% { transform:translate(-1%,.4%) scale(1.1); } 50% { transform:translate(1%,-.6%) scale(1.1); } 100% { transform:translate(-.6%,-.4%) scale(1.1); } }
@keyframes bossDie { 0% { transform:translateY(0) rotate(0) scale(1.08); } 18% { transform:translateY(-9%) rotate(-7deg) scale(1.12); } 55% { transform:translateY(4%) rotate(9deg) scale(1,.94); } 75% { transform:translateY(0) rotate(6deg) scale(.99,1.01); } 100% { transform:translateY(3%) rotate(8deg) scale(.97,.95); filter:saturate(.7) brightness(.85); } }
`;
(function () {
  const st = document.createElement('style');
  st.textContent = BOSS_CSS;
  document.head.appendChild(st);
})();
