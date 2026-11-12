'use strict';
(() => {
  const menu=document.getElementById('app-menu');
  const trigger=document.getElementById('menu-open');
  const closeButton=document.getElementById('menu-close');
  const backdrop=document.getElementById('menu-backdrop');
  if(!menu||!trigger||!closeButton||!backdrop)return;

  function openMenu(){
    menu.hidden=false;
    menu.inert=false;
    menu.setAttribute('aria-hidden','false');
    backdrop.hidden=false;
    document.body.classList.add('menu-open');
    menu.classList.add('open');
    trigger.setAttribute('aria-expanded','true');
    closeButton.focus();
  }
  function closeMenu(returnFocus=true){
    if(menu.hidden)return;
    menu.classList.remove('open');
    menu.inert=true;
    menu.setAttribute('aria-hidden','true');
    backdrop.hidden=true;
    document.body.classList.remove('menu-open');
    trigger.setAttribute('aria-expanded','false');
    menu.hidden=true;
    if(returnFocus)trigger.focus();
  }

  trigger.addEventListener('click',event=>{
    event.preventDefault();
    if(menu.hidden)openMenu();else closeMenu();
  });
  closeButton.addEventListener('click',()=>closeMenu());
  backdrop.addEventListener('click',()=>closeMenu());
  document.addEventListener('keydown',event=>{
    if(menu.hidden)return;
    if(event.key==='Escape'){event.preventDefault();closeMenu();return;}
    if(event.key!=='Tab')return;
    const focusable=[...menu.querySelectorAll('button:not([disabled]),summary,a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled])')]
      .filter(element=>element.getClientRects().length>0);
    if(!focusable.length)return;
    const first=focusable[0],last=focusable[focusable.length-1];
    if(event.shiftKey&&(document.activeElement===first||!menu.contains(document.activeElement))){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&(document.activeElement===last||!menu.contains(document.activeElement))){event.preventDefault();first.focus();}
  });
  document.addEventListener('click',event=>{
    if(event.target.closest('.menu-link')&&!menu.hidden)closeMenu(false);
  });
})();
