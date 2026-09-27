variable "db_password" {
  type      = string
  sensitive = true
}

resource "aws_db_instance" "orders" {
  identifier        = "orders-db"
  engine            = "postgres"
  instance_class    = "db.t3.micro"
  allocated_storage = 20
  username          = "app"
  password          = var.db_password
}

resource "aws_msk_cluster" "events" {
  cluster_name           = "orders-events"
  kafka_version          = "3.7.0"
  number_of_broker_nodes = 2
}

output "db_endpoint" {
  value = aws_db_instance.orders.endpoint
}
