use image::GenericImageView;
use ndarray::{ Array4, Array3 };
use ort::{
  memory::Allocator, value::{Tensor, Value}

};

use crate::tools;

pub struct FeaturesExtractor {
  expected_size: u32,
  pub features: Value,
}

impl FeaturesExtractor {
  pub fn new() -> Self {

    FeaturesExtractor {
      expected_size: 1024,
      features: Tensor::<f32>::new(&Allocator::default(), [1, 256, 64, 64]).unwrap().into_dyn(),
    }
  }
  pub fn prepare_image(&self, input_blob: Vec<u8>, width: usize, height: usize) -> Tensor<f32> {
    let image = self.load_blob_to_image(input_blob, width, height);
    println!("Image size: {:?}", image.dimensions());
    let image = image.resize_exact(
      self.expected_size,
      self.expected_size,
      image::imageops::FilterType::Nearest
    );
    let mut image_array = Array4::<f32>::zeros([
      1,
      3,
      self.expected_size as usize,
      self.expected_size as usize,
    ]);

    for (x, y, pixel) in image.pixels() {
      for c in 0..3 {
        image_array[[0, c, y as usize, x as usize]] = (pixel[c] as f32) / 255.0;
      }
    }

    Tensor::from_array(image_array).unwrap()
  }

  fn load_blob_to_image(&self, blob: Vec<u8>, width: usize, height: usize) -> image::DynamicImage {
    // Vec<8> is a list of RGB values. Format is [R, G, B, ...]
    image::DynamicImage::ImageRgba8(
      image::RgbaImage::from_raw(width as u32, height as u32, blob).unwrap()
    )
  }

  pub fn extract_features(
    &mut self,
    image: Tensor<f32>,
    session: &ort::session::Session
  ) -> Result<(), Box<dyn std::error::Error>> {
    println!("Running encoder inference");
    let mut io_binding = session.create_binding().unwrap();
    io_binding.bind_input("image", &image)?;
    io_binding.bind_output_to_device("features", &session.allocator().memory_info())?;

    self.features = io_binding.run().unwrap().remove("features").unwrap();
    Ok(())
    
  }
  pub fn get_features(&self) -> &Value {
    &self.features
  }

}
