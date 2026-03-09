document.addEventListener("DOMContentLoaded", function() {
  console.log("The Pulse of AI Dashboard Loading...");
  
  const refreshBtn = document.getElementById("refresh-btn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      location.reload();
    });
  }
  
  fetch("/api/health")
    .then(r => r.json())
    .then(data => {
      document.getElementById("health-status").innerHTML = `
        <span class="status-dot green"></span>
        <span>System Healthy</span>
      `;
    })
    .catch(() => {
      document.getElementById("health-status").innerHTML = `
        <span class="status-dot red"></span>
        <span>System Error</span>
      `;
    });
});
