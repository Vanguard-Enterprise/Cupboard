variable "IMAGE_TAG" {
  default = "local"
}

group "default" {
  targets = ["api", "web"]
}

target "api" {
  context = "."
  dockerfile = "backend/Dockerfile"
  tags = ["cupboard-api:${IMAGE_TAG}"]
  cache-from = ["type=gha,version=2,scope=cupboard-api"]
  cache-to = ["type=gha,version=2,scope=cupboard-api,mode=max"]
}

target "web" {
  context = "."
  dockerfile = "Dockerfile"
  tags = ["cupboard-web:${IMAGE_TAG}"]
  cache-from = ["type=gha,version=2,scope=cupboard-web"]
  cache-to = ["type=gha,version=2,scope=cupboard-web,mode=max"]
}
