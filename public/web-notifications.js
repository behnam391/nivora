(() => {
  const key='nivora_seen_notifications_v1', seen=new Set(JSON.parse(localStorage.getItem(key)||'[]'));
  let primed=seen.size>0;
  const beep=()=>{const A=window.AudioContext||window.webkitAudioContext;if(!A)return;const c=new A(),o=c.createOscillator(),g=c.createGain();o.frequency.value=880;g.gain.setValueAtTime(.0001,c.currentTime);g.gain.exponentialRampToValueAtTime(.18,c.currentTime+.02);g.gain.exponentialRampToValueAtTime(.0001,c.currentTime+.35);o.connect(g).connect(c.destination);o.start();o.stop(c.currentTime+.36);o.onended=()=>c.close()};
  async function enable(){if('Notification'in window&&Notification.permission==='default')await Notification.requestPermission()}
  function publish(items=[]){const fresh=items.filter(x=>!x.read_at&&!seen.has(x.id));items.forEach(x=>seen.add(x.id));while(seen.size>150)seen.delete(seen.values().next().value);localStorage.setItem(key,JSON.stringify([...seen]));if(!primed){primed=true;return}if(!fresh.length)return;beep();if('Notification'in window&&Notification.permission==='granted')fresh.slice(0,3).forEach(x=>new Notification(x.title,{body:x.body,icon:'/brand-mark.svg',tag:x.id}))}
  document.addEventListener('click',enable,{once:true});window.NivoraNotifications={enable,publish};
})();
