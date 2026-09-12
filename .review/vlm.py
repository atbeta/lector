import base64, json, sys, urllib.request, os
img, q = sys.argv[1], sys.argv[2]
model = os.environ.get("VLM_MODEL", "qwen3.6:35b-a3b")
b = base64.b64encode(open(img, "rb").read()).decode()
payload = {
  "model": model,
  "messages": [{"role": "user", "content": q, "images": [b]}],
  "stream": False,
  "think": False,
  "options": {"temperature": 0.1, "num_ctx": 8192},
}
req = urllib.request.Request("http://192.168.5.103:11434/api/chat",
  data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
try:
    r = json.loads(urllib.request.urlopen(req, timeout=600).read())
    print(r.get("message", {}).get("content", "").strip())
except Exception as e:
    print("VLM ERROR:", e)
