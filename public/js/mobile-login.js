const form=document.getElementById('pair-form'),error=document.getElementById('pair-error');
form.onsubmit=async event=>{
  event.preventDefault();const button=form.querySelector('button');button.disabled=true;error.textContent='';
  try {
    const response=await fetch('/api/access/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:document.getElementById('pair-code').value.trim()})});
    const data=await response.json();if(!response.ok)throw Error(data.error||'连接失败');location.replace('/');
  }catch(reason){error.textContent=reason.message;}finally{button.disabled=false;}
};
