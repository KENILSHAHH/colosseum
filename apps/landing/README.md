# Landing page (payi.finance)

Static files served by `/opt/payi/server.js` on the `pm5m-collector` server (Caddy proxies payi.finance to port 3000).
Deploy: copy `public/*` to `/opt/payi/public/` on that server (user `ec2-user`, key `~/.ssh/pm5m-collector.pem`). No restart is needed.
Every call to action links to the app at https://app.payi.finance.
