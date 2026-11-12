'use strict';
(() => {
  const panels=[...document.querySelectorAll('[data-page-panel]')];
  const links=[...document.querySelectorAll('.menu-link')];
  if(!panels.length||!links.length)return;

  document.addEventListener('click',event=>{
    const target=event.target;
    if(!target||typeof target.closest!=='function')return;
    const link=target.closest('.menu-link[data-page],.menu-link[data-trend]');
    if(!link)return;
    const trend=link.dataset.trend||'';
    const page=link.dataset.page||'trend';
    panels.forEach(panel=>{panel.hidden=panel.dataset.pagePanel!==page;});
    links.forEach(item=>item.classList.toggle('active',item===link));
    const trendGroup=document.querySelector('.menu-trends');
    if(trendGroup)trendGroup.open=false;
    if(trend)window.dispatchEvent(new CustomEvent('donation-log:trend-selected',{detail:{trend}}));
  });
})();
