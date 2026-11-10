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
}

target "web" {
  context = "."
  dockerfile = "Dockerfile"
  tags = ["cupboard-web:${IMAGE_TAG}"]
}
