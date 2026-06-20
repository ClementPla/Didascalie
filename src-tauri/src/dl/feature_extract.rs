use ndarray::Array4;
use ort::{
    memory::Allocator,
    value::{Tensor, Value},
};
use rayon::prelude::*;

pub struct FeaturesExtractor {
    expected_size: u32,
    pub features: Value,
}

impl FeaturesExtractor {
    pub fn new() -> Self {
        FeaturesExtractor {
            expected_size: 1024,
            features: Tensor::<f32>::new(&Allocator::default(), [1usize, 256, 64, 64])
                .unwrap()
                .into_dyn(),
        }
    }
    pub fn prepare_image(
        &self,
        input_blob: Vec<u8>,
        width: usize,
        height: usize,
    ) -> Result<Tensor<f32>, String> {
        let image = self.load_blob_to_image(input_blob, width, height)?;

        let image = image
            .resize_exact(
                self.expected_size,
                self.expected_size,
                image::imageops::FilterType::CatmullRom,
            )
            .to_rgba8();

        let size = self.expected_size as usize;
        let raw = image.as_raw();
        let plane_size = size * size;

        let mut data = vec![0.0f32; 3 * plane_size];
        let scale = 1.0 / 255.0;

        // Split into R, G, B planes
        let (r_plane, rest) = data.split_at_mut(plane_size);
        let (g_plane, b_plane) = rest.split_at_mut(plane_size);

        // Process in parallel - note: 4 bytes per pixel (RGBA)
        [r_plane, g_plane, b_plane]
            .into_par_iter()
            .enumerate()
            .for_each(|(c, plane)| {
                for i in 0..plane_size {
                    plane[i] = (raw[i * 4 + c] as f32) * scale;
                }
            });

        let array = Array4::from_shape_vec([1, 3, size, size], data)
            .map_err(|e| format!("Failed to build image array: {}", e))?;
        Tensor::from_array(array).map_err(|e| format!("Failed to build image tensor: {}", e))
    }

    fn load_blob_to_image(
        &self,
        blob: Vec<u8>,
        width: usize,
        height: usize,
    ) -> Result<image::DynamicImage, String> {
        let img = image::RgbaImage::from_raw(width as u32, height as u32, blob)
            .ok_or_else(|| {
                format!(
                    "Image buffer does not match dimensions {}x{} (expected {} bytes)",
                    width,
                    height,
                    width * height * 4
                )
            })?;
        Ok(image::DynamicImage::ImageRgba8(img))
    }

    pub fn __extract_features__(
        &mut self,
        image: Tensor<f32>,
        session: &mut ort::session::Session,
    ) -> Result<(), String> {
        println!("Running encoder inference");
        let mut io_binding = session
            .create_binding()
            .map_err(|e| format!("Failed to create encoder binding: {}", e))?;
        io_binding
            .bind_input("image", &image)
            .map_err(|e| format!("Failed to bind image: {}", e))?;
        io_binding
            .bind_output_to_device("features", &session.allocator().memory_info())
            .map_err(|e| format!("Failed to bind features output: {}", e))?;

        self.features = session
            .run_binding(&mut io_binding)
            .map_err(|e| format!("Encoder inference failed: {}", e))?
            .remove("features")
            .ok_or("Encoder produced no 'features' output")?;

        Ok(())
    }
    pub fn get_features(&self) -> &ort::value::Value {
        &self.features
    }
}
