import os

import uvicorn


def main() -> None:
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    print(f"Overture Italy explorer: http://{host}:{port}")
    uvicorn.run("server.main:app", host=host, port=port)


if __name__ == "__main__":
    main()
