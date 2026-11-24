'use strict';
(() => {
  const panels=[...document.querySelectorAll('[data-page-panel]')];
  const links=[...document.querySelectorAll('.menu-link[data-page],.menu-link[data-trend]')];
  if(!panels.length||!links.length)return;

  for(const link of links){
    link.addEventListener('click',()=>{
      const trend=link.dataset.trend||'';
      const selectedPage=link.dataset.page||'trend';
      const page=selectedPage==='home'?'entry':selectedPage;
      panels.forEach(panel=>{panel.hidden=panel.dataset.pagePanel!==page;});
      for(const item of document.querySelectorAll('.menu-link')){
        item.classList.toggle('active',selectedPage!=='home'&&item===link);
      }
      const trendGroup=document.querySelector('.menu-trends');
      if(trendGroup)trendGroup.open=false;
      document.dispatchEvent(new CustomEvent('donation-log:close-menu',{detail:{returnFocus:false}}));
      document.dispatchEvent(new CustomEvent('donation-log:page-selected',{detail:{page:selectedPage}}));
      if(trend)window.dispatchEvent(new CustomEvent('donation-log:trend-selected',{detail:{trend}}));
    });
  }
})();
