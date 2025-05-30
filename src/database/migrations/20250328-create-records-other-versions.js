'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('records_other_versions', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      original_record_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'records',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      title: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      cabinet_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'cabinets',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      creator_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'users',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      file_path: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      file_name: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      file_size: {
        type: Sequelize.BIGINT,
        allowNull: true,
      },
      file_type: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      file_hash: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      version: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },
      status: {
        type: Sequelize.ENUM('draft', 'pending', 'approved', 'rejected', 'archived'),
        allowNull: false,
        defaultValue: 'draft',
      },
      metadata: {
        type: Sequelize.JSONB,
        allowNull: true,
      },
      custom_fields: {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: {},
      },
      tags: {
        type: Sequelize.ARRAY(Sequelize.STRING),
        allowNull: false,
        defaultValue: [],
      },
      is_template: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      is_active: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      last_modified_by: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'users',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      deleted_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
    });

    // Yaxşı performans üçün indekslər əlavə edirik
    await queryInterface.addIndex('records_other_versions', ['cabinet_id']);
    await queryInterface.addIndex('records_other_versions', ['creator_id']);
    await queryInterface.addIndex('records_other_versions', ['status']);
    await queryInterface.addIndex('records_other_versions', ['is_template']);
    await queryInterface.addIndex('records_other_versions', ['file_type']);
    await queryInterface.addIndex('records_other_versions', ['tags']);

    // JSONB custom_fields sütunu üçün GIN indeksləri
    await queryInterface.sequelize.query(`
      CREATE INDEX records_other_versions_custom_fields_gin_idx ON records_other_versions USING GIN (custom_fields);
      CREATE INDEX records_other_versions_custom_fields_path_ops_idx ON records_other_versions USING GIN ((custom_fields -> 'fieldId') jsonb_path_ops);
      CREATE INDEX records_other_versions_custom_fields_value_ops_idx ON records_other_versions USING GIN ((custom_fields -> 'value') jsonb_path_ops);
    `);
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS records_other_versions_custom_fields_gin_idx;
      DROP INDEX IF EXISTS records_other_versions_custom_fields_path_ops_idx;
      DROP INDEX IF EXISTS records_other_versions_custom_fields_value_ops_idx;
    `);
    await queryInterface.dropTable('records_other_versions');
  }
};
