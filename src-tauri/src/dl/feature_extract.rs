use image::GenericImageView;
use ndarray::Array4;
use ort::{ memory::Allocator, value::{ Tensor, Value } };
use rayon::prelude::*;

pub struct FeaturesExtractor {
  expected_size: u32,
  pub features: Value,
}

impl FeaturesExtractor {
  pub fn new() -> Self {
    FeaturesExtractor {
      expected_size: 1024,
      features: Tensor::<f32>
        ::new(&Allocator::default(), [1usize, 256, 64, 64])
        .unwrap()
        .into_dyn(),
    }
  }
  pub fn prepare_image(&self, input_blob: Vec<u8>, width: usize, height: usize) -> Tensor<f32> {
    let image = self.load_blob_to_image(input_blob, width, height);

    let image = image
      .resize_exact(self.expected_size, self.expected_size, image::imageops::FilterType::CatmullRom)
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

    let array = Array4::from_shape_vec([1, 3, size, size], data).unwrap();
    Tensor::from_array(array).unwrap()
  }

  fn load_blob_to_image(&self, blob: Vec<u8>, width: usize, height: usize) -> image::DynamicImage {
    image::DynamicImage::ImageRgba8(
      image::RgbaImage::from_raw(width as u32, height as u32, blob).unwrap()
    )
  }

  pub fn __extract_features__(
    &mut self,
    image: Tensor<f32>,
    session: &mut ort::session::Session
  ) -> Result<(), ort::Error> {
    println!("Running encoder inference");
    let mut io_binding = session.create_binding()?;
    io_binding.bind_input("image", &image)?;
    io_binding.bind_output_to_device("features", &session.allocator().memory_info())?;

    self.features = session.run_binding(&mut io_binding)?.remove("features").unwrap();

    Ok(())
  }
  pub fn get_features(&self) -> &ort::value::Value {
    &self.features
  }
}
