use object_store::{ClientOptions, ObjectStore, RetryConfig, aws::AmazonS3Builder};
use std::{sync::Arc, time::Duration};

#[derive(Clone)]
pub struct FileStore(pub Arc<dyn ObjectStore>);

impl FileStore {
    // No Debug implementation: configuration and provider errors can contain secrets.
    pub fn from_env() -> Result<Option<Self>, &'static str> {
        let Ok(bucket) = std::env::var("CUPBOARD_S3_BUCKET") else {
            if std::env::vars().any(|(key, _)| key.starts_with("CUPBOARD_S3_")) {
                return Err("CUPBOARD_S3_BUCKET is required when configuring storage");
            }
            return Ok(None);
        };
        if bucket.trim().is_empty() {
            return Err("CUPBOARD_S3_BUCKET must not be empty");
        }
        let mut builder = AmazonS3Builder::from_env()
            .with_bucket_name(bucket)
            .with_region(std::env::var("AWS_REGION").unwrap_or_else(|_| "us-east-1".into()))
            .with_virtual_hosted_style_request(false)
            .with_client_options(ClientOptions::new().with_timeout(Duration::from_secs(20)))
            .with_retry(RetryConfig {
                max_retries: 1,
                retry_timeout: Duration::from_secs(25),
                ..Default::default()
            });
        if let Ok(endpoint) = std::env::var("CUPBOARD_S3_ENDPOINT") {
            builder = builder.with_endpoint(endpoint);
        }
        builder =
            builder.with_allow_http(std::env::var("CUPBOARD_S3_ALLOW_HTTP").as_deref() == Ok("1"));
        builder
            .build()
            .map(|store| Some(Self(Arc::new(store))))
            .map_err(|_| "S3 configuration is invalid")
    }
}
