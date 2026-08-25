(()=>{
  const scope=location.pathname.startsWith('/reseller')?'reseller':location.pathname.startsWith('/account')?'customer':'web';
  const key=`nivora_seen_notifications_v2_${scope}`;
  let stored=[];
  try{const parsed=JSON.parse(localStorage.getItem(key)||'[]');stored=Array.isArray(parsed)?parsed:[]}catch{stored=[]}
  const seen=new Set(stored.map(String));
  let primed=seen.size>0;

  const persist=()=>{try{localStorage.setItem(key,JSON.stringify([...seen]))}catch{}}
  const beep=async()=>{
    const Audio=window.AudioContext||window.webkitAudioContext;
    if(!Audio||navigator.userActivation?.hasBeenActive===false)return;
    try{
      const context=new Audio();if(context.state==='suspended')await context.resume();
      const oscillator=context.createOscillator(),gain=context.createGain();oscillator.frequency.value=880;
      gain.gain.setValueAtTime(.0001,context.currentTime);gain.gain.exponentialRampToValueAtTime(.12,context.currentTime+.02);gain.gain.exponentialRampToValueAtTime(.0001,context.currentTime+.3);
      oscillator.connect(gain).connect(context.destination);oscillator.start();oscillator.stop(context.currentTime+.31);oscillator.onended=()=>context.close();
    }catch{}
  };
  async function enable(){try{if('Notification'in window&&Notification.permission==='default')await Notification.requestPermission()}catch{}}
  function publish(items=[]){
    const rows=Array.isArray(items)?items:[];
    const fresh=rows.filter(item=>item?.id&&!item.read_at&&!seen.has(String(item.id)));
    rows.forEach(item=>{if(item?.id)seen.add(String(item.id))});while(seen.size>150)seen.delete(seen.values().next().value);persist();
    if(!primed){primed=true;return}if(!fresh.length)return;
    void beep();
    if('Notification'in window&&Notification.permission==='granted')fresh.slice(0,3).forEach(item=>{try{new Notification(String(item.title||'Nivora'),{body:String(item.body||''),icon:'/brand-mark.png',tag:String(item.id)})}catch{}});
  }
  document.addEventListener('click',()=>{void enable()},{once:true});
  window.NivoraNotifications={enable,publish};
})();
