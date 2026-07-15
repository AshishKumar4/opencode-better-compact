import installer from "./install.sh"

export default {
    fetch(request: Request): Response {
        if (new URL(request.url).pathname !== "/") {
            return new Response("Not found\n", { status: 404 })
        }

        return new Response(installer, {
            headers: { "content-type": "text/plain; charset=utf-8" },
        })
    },
}
