"""RyuCore 竜核 — entry point."""
import uvicorn

from ryucore import config

if __name__ == "__main__":
    uvicorn.run("ryucore.server:app", host=config.BIND, port=config.PORT, log_level="info",
                proxy_headers=True, forwarded_allow_ips="*")
